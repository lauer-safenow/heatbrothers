import { useState, useCallback, useRef, useEffect } from "react";
import "./ble-scanner.css";

interface BleDevice {
  id: string;
  name: string | null;
  rssi: number;
  txPower: number | null;
  manufacturerData: string | null;
  serviceUuids: string[];
  lastSeen: number;
  // iBeacon fields (parsed from manufacturer data)
  major?: number;
  minor?: number;
  uuid?: string;
}

// Parse iBeacon from manufacturer data (Apple company ID 0x004C, type 0x0215)
function parseIBeacon(data: DataView): { uuid: string; major: number; minor: number; txPower: number } | null {
  // iBeacon format: 0x02 0x15 [16-byte UUID] [2-byte major] [2-byte minor] [1-byte txPower]
  if (data.byteLength < 23) return null;

  // Find iBeacon prefix (0x02 0x15)
  for (let i = 0; i <= data.byteLength - 23; i++) {
    if (data.getUint8(i) === 0x02 && data.getUint8(i + 1) === 0x15) {
      const uuidBytes: string[] = [];
      for (let j = 0; j < 16; j++) {
        uuidBytes.push(data.getUint8(i + 2 + j).toString(16).padStart(2, "0"));
      }
      const uuid = [
        uuidBytes.slice(0, 4).join(""),
        uuidBytes.slice(4, 6).join(""),
        uuidBytes.slice(6, 8).join(""),
        uuidBytes.slice(8, 10).join(""),
        uuidBytes.slice(10, 16).join(""),
      ].join("-");

      const major = data.getUint16(i + 18, false);
      const minor = data.getUint16(i + 20, false);
      const txPower = data.getInt8(i + 22);
      return { uuid, major, minor, txPower };
    }
  }
  return null;
}

function manufacturerDataToHex(data: DataView): string {
  const bytes: string[] = [];
  for (let i = 0; i < data.byteLength; i++) {
    bytes.push(data.getUint8(i).toString(16).padStart(2, "0"));
  }
  return bytes.join(" ");
}

export default function BleScanner() {
  const [devices, setDevices] = useState<Map<string, BleDevice>>(new Map());
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const [filter, setFilter] = useState("");
  const scanRef = useRef<BluetoothLEScan | null>(null);

  useEffect(() => {
    const hasBt = !!navigator.bluetooth;
    // @ts-expect-error — experimental API
    const hasScan = hasBt && typeof navigator.bluetooth.requestLEScan === "function";
    if (!hasScan) {
      setSupported(false);
      console.log("[BLE] bluetooth:", hasBt, "requestLEScan:", hasScan);
    }
  }, []);

  const startScan = useCallback(async () => {
    setError(null);
    try {
      // @ts-expect-error — experimental API
      const scan: BluetoothLEScan = await navigator.bluetooth.requestLEScan({
        acceptAllAdvertisements: true,
      });
      console.log("[BLE] Scan started:", scan);
      scanRef.current = scan;
      setScanning(true);

      navigator.bluetooth.addEventListener("advertisementreceived", (event: Event) => {
        const e = event as BluetoothAdvertisingEvent;
        const id = e.device.id;
        let manufacturerHex: string | null = null;
        let ibeacon: { uuid: string; major: number; minor: number; txPower: number } | null = null;

        if (e.manufacturerData) {
          e.manufacturerData.forEach((data: DataView) => {
            manufacturerHex = manufacturerDataToHex(data);
            const parsed = parseIBeacon(data);
            if (parsed) ibeacon = parsed;
          });
        }

        const serviceUuids: string[] = [];
        if (e.uuids) {
          for (const uuid of e.uuids) {
            serviceUuids.push(String(uuid));
          }
        }

        setDevices((prev) => {
          const next = new Map(prev);
          next.set(id, {
            id,
            name: e.device.name ?? null,
            rssi: e.rssi ?? -999,
            txPower: e.txPower ?? null,
            manufacturerData: manufacturerHex,
            serviceUuids,
            lastSeen: Date.now(),
            ...(ibeacon ? { major: ibeacon.major, minor: ibeacon.minor, uuid: ibeacon.uuid } : {}),
          });
          return next;
        });
      });
    } catch (err) {
      setError(String(err));
      setScanning(false);
    }
  }, []);

  const stopScan = useCallback(() => {
    if (scanRef.current) {
      scanRef.current.stop();
      scanRef.current = null;
    }
    setScanning(false);
  }, []);

  const clearDevices = useCallback(() => {
    setDevices(new Map());
  }, []);

  // Sort devices: iBeacons first, then by RSSI (strongest first)
  const deviceList = [...devices.values()]
    .filter((d) => {
      if (!filter) return true;
      const f = filter.toLowerCase();
      return (
        (d.name && d.name.toLowerCase().includes(f)) ||
        (d.uuid && d.uuid.toLowerCase().includes(f)) ||
        (d.major !== undefined && `${d.major}:${d.minor}`.includes(f)) ||
        d.id.toLowerCase().includes(f)
      );
    })
    .sort((a, b) => {
      // iBeacons first
      if (a.major !== undefined && b.major === undefined) return -1;
      if (a.major === undefined && b.major !== undefined) return 1;
      // Then by RSSI
      return b.rssi - a.rssi;
    });

  const ibeaconCount = deviceList.filter((d) => d.major !== undefined).length;

  if (!supported) {
    return (
      <div className="ble-scanner">
        <div className="ble-unsupported">
          <h3>BLE Scanning Not Available</h3>
          <p>Your browser doesn't support the Web Bluetooth Scanning API.</p>
          <p>To enable it:</p>
          <ol>
            <li>Open <code>chrome://flags/#enable-experimental-web-platform-features</code></li>
            <li>Set to <strong>Enabled</strong></li>
            <li>Restart Chrome</li>
          </ol>
          <p>This feature requires Chrome/Edge on desktop or Android.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="ble-scanner">
      <div className="ble-controls">
        {!scanning ? (
          <button className="ble-start-btn" onClick={startScan}>Start Scanning</button>
        ) : (
          <button className="ble-stop-btn" onClick={stopScan}>Stop Scanning</button>
        )}
        <button className="ble-clear-btn" onClick={clearDevices} disabled={devices.size === 0}>
          Clear
        </button>
        <input
          type="text"
          className="ble-filter"
          placeholder="Filter by name, UUID, major:minor..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="ble-count">
          {deviceList.length} device{deviceList.length !== 1 ? "s" : ""}
          {ibeaconCount > 0 && ` (${ibeaconCount} iBeacon${ibeaconCount !== 1 ? "s" : ""})`}
        </span>
        {scanning && <span className="ble-live-dot" />}
      </div>

      {error && <div className="ble-error">{error}</div>}

      {deviceList.length > 0 && (
        <div className="ble-table-wrap">
          <table className="ble-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Name</th>
                <th>Major</th>
                <th>Minor</th>
                <th>RSSI</th>
                <th>UUID / ID</th>
                <th>Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {deviceList.map((d) => {
                const age = Math.round((Date.now() - d.lastSeen) / 1000);
                const stale = age > 10;
                return (
                  <tr key={d.id} className={stale ? "ble-row-stale" : ""}>
                    <td>
                      <span className={`ble-type ${d.major !== undefined ? "ble-type--ibeacon" : "ble-type--other"}`}>
                        {d.major !== undefined ? "iBeacon" : "BLE"}
                      </span>
                    </td>
                    <td>{d.name ?? <span className="ble-dim">unknown</span>}</td>
                    <td>{d.major ?? ""}</td>
                    <td>{d.minor ?? ""}</td>
                    <td>
                      <span className={`ble-rssi ${d.rssi > -60 ? "ble-rssi--strong" : d.rssi > -80 ? "ble-rssi--medium" : "ble-rssi--weak"}`}>
                        {d.rssi} dBm
                      </span>
                    </td>
                    <td className="ble-uuid">{d.uuid ?? d.id}</td>
                    <td className="ble-age">{age}s ago</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {deviceList.length === 0 && scanning && (
        <p className="ble-empty">Listening for BLE advertisements...</p>
      )}
      {deviceList.length === 0 && !scanning && (
        <p className="ble-empty">Press "Start Scanning" to discover nearby BLE devices.</p>
      )}
    </div>
  );
}

// TypeScript declarations for experimental BLE scanning API
interface BluetoothLEScan {
  stop(): void;
  active: boolean;
}

interface BluetoothAdvertisingEvent extends Event {
  device: BluetoothDevice;
  rssi: number;
  txPower: number;
  manufacturerData: Map<number, DataView>;
  uuids: string[];
}
