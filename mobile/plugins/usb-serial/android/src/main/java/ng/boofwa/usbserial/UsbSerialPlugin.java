// SPDX-License-Identifier: GPL-3.0-or-later
package ng.boofwa.usbserial;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.util.Base64;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.hoho.android.usbserial.driver.UsbSerialDriver;
import com.hoho.android.usbserial.driver.UsbSerialPort;
import com.hoho.android.usbserial.driver.UsbSerialProber;
import com.hoho.android.usbserial.util.SerialInputOutputManager;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

/**
 * USB serial for the Android app.
 *
 * What a programming cable needs and nothing more: list, ask permission, open
 * with the modem lines where the caller wants them, write, read, close. Every
 * design choice below exists because of a radio:
 *
 * - DTR and RTS are set the instant the port opens, before the line
 *   parameters. Several UV-K5 cables and every two-pin Kenwood cable reset the
 *   radio when either line is asserted, and the drivers in lib/radios deassert
 *   both. A chip whose driver cannot control the lines fails the open, because
 *   a port with the lines wherever the silicon left them is a port that may
 *   already have rebooted the radio.
 *
 * - Bytes leave as events, one per USB read, base64 encoded. Nothing is
 *   coalesced: the DM-32UV's programming-mode entry is paced in 10 ms steps,
 *   and a delay added here to save bridge round trips would be added to that.
 *
 * - close() does what the library's close does and no more. On a desktop the
 *   OS drops DTR when a port closes and the DM-32UV leaves programming mode on
 *   that; whether this library's close does the same is unverified, and a DTR
 *   pulse added on speculation would assert the line every radio is reset by.
 *   docs/mobile.md carries the item.
 *
 * Nothing here has been compiled or run against a radio yet.
 */
@CapacitorPlugin(name = "UsbSerial")
public class UsbSerialPlugin extends Plugin {
    private static final String ACTION_PERMISSION = "ng.boofwa.usbserial.USB_PERMISSION";
    private static final int WRITE_TIMEOUT_MS = 2000;

    private static final class Open {
        final int deviceId;
        final UsbSerialPort port;
        final UsbDeviceConnection connection;
        final SerialInputOutputManager io;

        Open(int deviceId, UsbSerialPort port, UsbDeviceConnection connection, SerialInputOutputManager io) {
            this.deviceId = deviceId;
            this.port = port;
            this.connection = connection;
            this.io = io;
        }
    }

    private final Map<String, Open> opens = new HashMap<>();
    private int nextHandle = 1;
    private PluginCall pendingPermission = null;
    private BroadcastReceiver receiver = null;

    private UsbManager usbManager() {
        return (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
    }

    @Override
    public void load() {
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (action == null) return;
                UsbDevice device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                switch (action) {
                    case ACTION_PERMISSION: {
                        boolean granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
                        PluginCall call = pendingPermission;
                        pendingPermission = null;
                        if (call != null) {
                            JSObject ret = new JSObject();
                            ret.put("granted", granted);
                            call.resolve(ret);
                        }
                        break;
                    }
                    case UsbManager.ACTION_USB_DEVICE_DETACHED: {
                        if (device == null) return;
                        closeAllFor(device.getDeviceId());
                        JSObject ret = new JSObject();
                        ret.put("deviceId", device.getDeviceId());
                        notifyListeners("detached", ret);
                        break;
                    }
                    case UsbManager.ACTION_USB_DEVICE_ATTACHED: {
                        if (device == null) return;
                        UsbSerialDriver driver = UsbSerialProber.getDefaultProber().probeDevice(device);
                        if (driver != null) notifyListeners("attached", describe(device, driver));
                        break;
                    }
                    default:
                }
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(ACTION_PERMISSION);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        // Not exported: the permission broadcast is ours alone, and Android 14
        // refuses an unflagged registration for a non-system action.
        ContextCompat.registerReceiver(getContext(), receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override
    protected void handleOnDestroy() {
        for (String handle : opens.keySet().toArray(new String[0])) closeHandle(handle);
        if (receiver != null) {
            try {
                getContext().unregisterReceiver(receiver);
            } catch (IllegalArgumentException ignored) {
                // Already gone.
            }
            receiver = null;
        }
    }

    private JSObject describe(UsbDevice device, UsbSerialDriver driver) {
        JSObject o = new JSObject();
        o.put("deviceId", device.getDeviceId());
        o.put("vendorId", device.getVendorId());
        o.put("productId", device.getProductId());
        if (device.getProductName() != null) o.put("productName", device.getProductName());
        if (device.getManufacturerName() != null) o.put("manufacturerName", device.getManufacturerName());
        o.put("driver", driver.getClass().getSimpleName().replace("SerialDriver", ""));
        o.put("hasPermission", usbManager().hasPermission(device));
        return o;
    }

    private static String ids(UsbDevice device) {
        return String.format("%04x:%04x", device.getVendorId(), device.getProductId());
    }

    private UsbDevice findDevice(int deviceId) {
        for (UsbDevice device : usbManager().getDeviceList().values()) {
            if (device.getDeviceId() == deviceId) return device;
        }
        return null;
    }

    @PluginMethod
    public void listDevices(PluginCall call) {
        JSArray devices = new JSArray();
        UsbSerialProber prober = UsbSerialProber.getDefaultProber();
        for (UsbDevice device : usbManager().getDeviceList().values()) {
            UsbSerialDriver driver = prober.probeDevice(device);
            // Only devices a driver claims. A phone's USB bus carries plenty
            // that is not a serial adapter, and none of it is a radio.
            if (driver != null) devices.put(describe(device, driver));
        }
        JSObject ret = new JSObject();
        ret.put("devices", devices);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        Integer deviceId = call.getInt("deviceId");
        UsbDevice device = deviceId == null ? null : findDevice(deviceId);
        if (device == null) {
            call.reject("No USB device with id " + deviceId + " is attached.");
            return;
        }
        if (usbManager().hasPermission(device)) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        if (pendingPermission != null) {
            call.reject("A permission request is already open.");
            return;
        }
        pendingPermission = call;
        // Explicit and mutable: Android 12 needs FLAG_MUTABLE for the system
        // to fill in the grant extra, and Android 14 refuses an implicit
        // intent behind a mutable PendingIntent.
        Intent intent = new Intent(ACTION_PERMISSION).setPackage(getContext().getPackageName());
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
        PendingIntent pi = PendingIntent.getBroadcast(getContext(), 0, intent, flags);
        usbManager().requestPermission(device, pi);
    }

    @PluginMethod
    public void open(PluginCall call) {
        Integer deviceId = call.getInt("deviceId");
        UsbDevice device = deviceId == null ? null : findDevice(deviceId);
        if (device == null) {
            call.reject("No USB device with id " + deviceId + " is attached.");
            return;
        }
        UsbSerialDriver driver = UsbSerialProber.getDefaultProber().probeDevice(device);
        if (driver == null) {
            call.reject("No serial driver claims USB device " + ids(device) + ".");
            return;
        }
        if (!usbManager().hasPermission(device)) {
            call.reject("USB device " + ids(device) + " has not been granted. Ask for permission first.");
            return;
        }
        UsbDeviceConnection connection = usbManager().openDevice(device);
        if (connection == null) {
            call.reject("Android refused to open USB device " + ids(device) + ".");
            return;
        }
        UsbSerialPort port = driver.getPorts().get(0);
        try {
            port.open(connection);
            // The lines first, before anything else touches the chip. See the
            // class comment: an asserted DTR or RTS resets these radios.
            try {
                port.setDTR(call.getBoolean("dtr", false));
                port.setRTS(call.getBoolean("rts", false));
            } catch (UnsupportedOperationException e) {
                port.close();
                call.reject(
                    "The " + driver.getClass().getSimpleName() + " driver cannot set DTR and RTS on " + ids(device) +
                    ", so the lines cannot be kept deasserted and the radio may be reset. Use a different adapter."
                );
                return;
            }
            int dataBits = call.getInt("dataBits", 8);
            int stopBits = call.getInt("stopBits", 1) == 2 ? UsbSerialPort.STOPBITS_2 : UsbSerialPort.STOPBITS_1;
            String parityName = call.getString("parity", "none");
            int parity = "even".equals(parityName)
                ? UsbSerialPort.PARITY_EVEN
                : "odd".equals(parityName) ? UsbSerialPort.PARITY_ODD : UsbSerialPort.PARITY_NONE;
            port.setParameters(call.getInt("baudRate", 9600), dataBits, stopBits, parity);
        } catch (IOException | RuntimeException e) {
            try {
                port.close();
            } catch (IOException ignored) {
                // Already failing.
            }
            connection.close();
            call.reject("Could not open USB device " + ids(device) + ": " + e.getMessage());
            return;
        }

        String handle = String.valueOf(nextHandle++);
        SerialInputOutputManager io = new SerialInputOutputManager(port, new SerialInputOutputManager.Listener() {
            @Override
            public void onNewData(byte[] data) {
                JSObject ev = new JSObject();
                ev.put("handle", handle);
                ev.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
                notifyListeners("data", ev);
            }

            @Override
            public void onRunError(Exception e) {
                JSObject ev = new JSObject();
                ev.put("handle", handle);
                ev.put("message", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
                notifyListeners("error", ev);
                closeHandle(handle);
            }
        });
        opens.put(handle, new Open(device.getDeviceId(), port, connection, io));
        // Its own thread. Reads block; the bridge must not.
        io.start();

        JSObject ret = new JSObject();
        ret.put("handle", handle);
        call.resolve(ret);
    }

    @PluginMethod
    public void write(PluginCall call) {
        Open open = opens.get(call.getString("handle"));
        if (open == null) {
            call.reject("That port is not open.");
            return;
        }
        String data = call.getString("data");
        if (data == null) {
            call.reject("write needs data.");
            return;
        }
        // Capacitor runs plugin methods off the main thread, so the blocking
        // bulk transfer below does not stall the WebView.
        try {
            open.port.write(Base64.decode(data, Base64.NO_WRAP), WRITE_TIMEOUT_MS);
            call.resolve();
        } catch (IOException | RuntimeException e) {
            call.reject("Write failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void setSignals(PluginCall call) {
        Open open = opens.get(call.getString("handle"));
        if (open == null) {
            call.reject("That port is not open.");
            return;
        }
        try {
            if (call.hasOption("dtr")) open.port.setDTR(call.getBoolean("dtr", false));
            if (call.hasOption("rts")) open.port.setRTS(call.getBoolean("rts", false));
            call.resolve();
        } catch (IOException | RuntimeException e) {
            call.reject("Could not set the modem lines: " + e.getMessage());
        }
    }

    @PluginMethod
    public void close(PluginCall call) {
        String handle = call.getString("handle");
        if (handle == null || !opens.containsKey(handle)) {
            // Closing twice is not a fault; the transport does it on teardown.
            call.resolve();
            return;
        }
        closeHandle(handle);
        call.resolve();
    }

    private void closeHandle(String handle) {
        Open open = opens.remove(handle);
        if (open == null) return;
        try {
            open.io.stop();
        } catch (RuntimeException ignored) {
            // Already stopped.
        }
        try {
            open.port.close();
        } catch (IOException | RuntimeException ignored) {
            // The device may already be gone.
        }
        open.connection.close();
    }

    private void closeAllFor(int deviceId) {
        for (Map.Entry<String, Open> e : opens.entrySet().toArray(new Map.Entry[0])) {
            if (e.getValue().deviceId == deviceId) closeHandle(e.getKey());
        }
    }
}
