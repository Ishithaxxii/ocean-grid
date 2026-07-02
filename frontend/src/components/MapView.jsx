import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
    MapContainer,
    TileLayer,
    Marker,
    Popup,
    Rectangle,
    Polyline,
    Tooltip,
    useMapEvents,
    useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

// ==========================================
// FIX DEFAULT MARKER ICON
// ==========================================
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
    iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
    iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
    shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const MARKER_COLORS = [
    "#e74c3c", "#3498db", "#2ecc71", "#f39c12",
    "#9b59b6", "#1abc9c", "#e67e22", "#e91e63",
    "#00bcd4", "#8bc34a", "#ff5722", "#607d8b",
    "#795548", "#ffc107", "#673ab7", "#009688",
];

const EEZ_STYLE = {
    color: "#ffff00",
    weight: 2,
    opacity: 0.8,
    fillColor: "#ffff00",
    fillOpacity: 0.05,
};

const BOX_STYLE = {
    color: "#00cfff",
    weight: 2,
    opacity: 0.9,
    fillColor: "#00cfff",
    fillOpacity: 0.08,
    dashArray: "5 4",
};

const GRID_SIZE = 5;
const GRID_LAT_MIN = -70;
const GRID_LAT_MAX = 30;
const GRID_LON_MIN = 20;
const GRID_LON_MAX = 120;
const GRID_COLS = (GRID_LON_MAX - GRID_LON_MIN) / GRID_SIZE;
const GRID_ROWS = (GRID_LAT_MAX - GRID_LAT_MIN) / GRID_SIZE;

const ALL_GRID_CELLS = (() => {
    const cells = [];
    for (let rowFromTop = 0; rowFromTop < GRID_ROWS; rowFromTop++) {
        for (let col = 0; col < GRID_COLS; col++) {
            const n      = rowFromTop * GRID_COLS + col + 1;
            const latMax = GRID_LAT_MAX - rowFromTop * GRID_SIZE;
            const latMin = latMax - GRID_SIZE;
            const lonMin = GRID_LON_MIN + col * GRID_SIZE;
            cells.push({
                gridId:    `Grid_${n}`,
                bounds:    [[latMin, lonMin], [latMax, lonMin + GRID_SIZE]],
                centerLat: latMin + GRID_SIZE / 2,
                centerLon: lonMin + GRID_SIZE / 2,
            });
        }
    }
    return cells;
})();

const GRID_STYLE_DEFAULT = {
    color: "#d6d6d6",
    weight: 0.8,
    opacity: 0.45,
    fillColor: "transparent",
    fillOpacity: 0,
    interactive: false,
};

const GRID_STYLE_ACTIVE = {
    color: "#00E5FF",
    weight: 2,
    opacity: 1,
    fillColor: "#00E5FF",
    fillOpacity: 0.08,
    interactive: true,
};

const GRID_STYLE_SELECTED = {
    color: "#FFB000",
    weight: 3,
    opacity: 1,
    fillColor: "#FFB000",
    fillOpacity: 0.12,
    interactive: true,
};


// Backend base URL for grid CSV export endpoints (see /grid-csv/{grid_id}
// and /grid-csv-all in main.py).
const API_BASE =
   import.meta.env.VITE_API_URL || "http://localhost:8000";

const iconCache = new Map();

function makeInstrumentIcon(instrumentType, color) {

    const cacheKey = `${instrumentType}-${color}`;

    if (iconCache.has(cacheKey)) {
        return iconCache.get(cacheKey);
    }

    const size = 20;
    let shapeSvg;

    if (instrumentType === "ctd") {

        shapeSvg = `
            <circle cx="10" cy="10" r="8" fill="white"/>
            <circle cx="10" cy="10" r="6" fill="${color}" stroke="#222" stroke-width="1"/>
        `;

    } else if (instrumentType === "xbt") {

        shapeSvg = `
            <polygon points="10,2 18,18 2,18" fill="white"/>
            <polygon points="10,4 16,16 4,16"
                     fill="${color}"
                     stroke="#222"
                     stroke-width="1"/>
        `;

    } else {

        shapeSvg = `
            <polygon points="10,1 19,10 10,19 1,10" fill="white"/>
            <polygon points="10,3 17,10 10,17 3,10"
                     fill="${color}"
                     stroke="#222"
                     stroke-width="1"/>
        `;
    }

    const svg = `
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="${size}"
            height="${size}"
            viewBox="0 0 20 20">
            ${shapeSvg}
        </svg>
    `;

    const icon = L.divIcon({
        html: svg,
        className: "",
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
        popupAnchor: [0, -size / 2],
    });

    iconCache.set(cacheKey, icon);

    return icon;
}

function generateShipColorMap(stations) {
    const ships = [...new Set(stations.map(s => s.ship || "Unknown"))];
    return Object.fromEntries(
        ships.map((ship, i) => [ship, MARKER_COLORS[i % MARKER_COLORS.length]])
    );
}

function extractEEZLoops(geojson) {
    const points = geojson.features
        .filter(f => f.geometry?.type === "Point")
        .map(f => [f.geometry.coordinates[1], f.geometry.coordinates[0]]);

    if (points.length === 0) return [];

    const loops = [];
    let currentLoop = [points[0]];
    const BREAK_THRESHOLD = 3.0;

    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const curr = points[i];
        const distance = Math.sqrt(
            Math.pow(curr[0] - prev[0], 2) +
            Math.pow(curr[1] - prev[1], 2)
        );
        if (distance > BREAK_THRESHOLD) {
            if (currentLoop.length > 1) loops.push(currentLoop);
            currentLoop = [curr];
        } else {
            currentLoop.push(curr);
        }
    }
    if (currentLoop.length > 1) loops.push(currentLoop);
    return loops;
}

function latLonToGridId(lat, lon) {
    if (lat < GRID_LAT_MIN || lat >= GRID_LAT_MAX || lon < GRID_LON_MIN || lon >= GRID_LON_MAX) {
        return null;
    }
    const rowFromTop = Math.floor((GRID_LAT_MAX - lat) / GRID_SIZE);
    const col         = Math.floor((lon - GRID_LON_MIN) / GRID_SIZE);
    return `Grid_${rowFromTop * GRID_COLS + col + 1}`;
}

// Triggers a browser download for a blob response from the grid-csv endpoints.
async function downloadFromApi(url, filename, onError) {
    try {
        const res = await fetch(url);
        if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw new Error(body?.detail || `Download failed (${res.status})`);
        }
        const blob = await res.blob();
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();
        URL.revokeObjectURL(link.href);
    } catch (err) {
        onError?.(err.message);
    }
}

// Shared numeric-input style for the manual bounding-box fields.
const boxInputStyle = {
    width:        "100%",
    background:   "rgba(0,0,0,0.35)",
    border:       "1px solid #334155",
    borderRadius: "4px",
    color:        "#e2e8f0",
    fontSize:     "12px",
    padding:      "5px 6px",
    fontFamily:   "monospace",
    boxSizing:    "border-box",
};

// BoxSelectHandler
// - Shift+drag always draws a box (unchanged legacy behavior).
// - When boxDrawMode is true, a plain click-drag (no Shift) also draws a
//   box, and the map cursor switches to a crosshair as a visual cue.
function BoxSelectHandler({ onBoundsChange, boxDrawMode }) {
    const dragStart  = useRef(null);
    const isDragging = useRef(false);
    const map = useMap();

    useEffect(() => {
        const container = map.getContainer();
        container.style.cursor = boxDrawMode ? "crosshair" : "";
        return () => {
            container.style.cursor = "";
        };
    }, [map, boxDrawMode]);

    useMapEvents({
        mousedown(e) {
            const shouldDraw = boxDrawMode || e.originalEvent.shiftKey;
            if (!shouldDraw) return;
            e.target.dragging.disable();
            isDragging.current = true;
            dragStart.current  = e.latlng;
            onBoundsChange(null, "drawing");
        },
        mousemove(e) {
            if (!isDragging.current || !dragStart.current) return;
            const start = dragStart.current;
            const end   = e.latlng;
            onBoundsChange({
                latMin: Math.min(start.lat, end.lat),
                latMax: Math.max(start.lat, end.lat),
                lonMin: Math.min(start.lng, end.lng),
                lonMax: Math.max(start.lng, end.lng),
            }, "drawing");
        },
        mouseup(e) {
            if (!isDragging.current || !dragStart.current) return;
            e.target.dragging.enable();
            isDragging.current = false;
            const start = dragStart.current;
            const end   = e.latlng;
            dragStart.current = null;
            const latMin = Math.min(start.lat, end.lat);
            const latMax = Math.max(start.lat, end.lat);
            const lonMin = Math.min(start.lng, end.lng);
            const lonMax = Math.max(start.lng, end.lng);
            if (Math.abs(latMax - latMin) < 0.01 && Math.abs(lonMax - lonMin) < 0.01) {
                onBoundsChange(null, "done");
                return;
            }
            onBoundsChange({ latMin, latMax, lonMin, lonMax }, "done");
        },
    });
    return null;
}

function ZoomWatcher({ onZoomChange }) {
    const map = useMap();
    useEffect(() => {
        onZoomChange(map.getZoom());
        map.on("zoomend", () => onZoomChange(map.getZoom()));
        return () => map.off("zoomend");
    }, [map, onZoomChange]);
    return null;
}

function ShiftDragHint({ spatialBounds, boxDrawMode }) {
    if (spatialBounds) return null;
    return (
        <div style={{
            position:      "absolute",
            bottom:        "24px",
            left:          "50%",
            transform:     "translateX(-50%)",
            zIndex:        1000,
            background:    "rgba(0,0,0,0.55)",
            color:         "#fff",
            fontSize:      "12px",
            padding:       "5px 10px",
            borderRadius:  "4px",
            pointerEvents: "none",
            whiteSpace:    "nowrap",
            userSelect:    "none",
        }}>
            {boxDrawMode
                ? "🖱 Click + drag to draw a bounding box  •  Box Mode is ON"
                : "⇧ Shift + drag to draw a bounding box  (or turn on Box Mode, top right)"}
        </div>
    );
}

// Consolidated top-right control cluster: grid toggle / bulk CSV download /
// box-draw-mode toggle. Kept in one place so the map doesn't accumulate
// scattered floating buttons.
function MapControls({
    showGrid, onToggleGrid,
    onDownloadAll, downloadingAll, downloadAllError,
    boxDrawMode, onToggleBoxDraw,
}) {
    const btnBase = {
        borderRadius:   "6px",
        padding:        "6px 12px",
        fontSize:       "12px",
        fontFamily:     "monospace",
        backdropFilter: "blur(4px)",
    };

    return (
        <div style={{
            position: "absolute", top: "12px", right: "12px", zIndex: 1000,
            display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "8px",
        }}>
            <div style={{ display: "flex", gap: "8px" }}>
                <button
                    onClick={onDownloadAll}
                    disabled={downloadingAll}
                    title="Download training CSVs for every populated 5x5 grid"
                    style={{
                        ...btnBase,
                        background: "rgba(0,0,0,0.55)",
                        color:      "#9be36b",
                        border:     "1px solid #3d5c2a",
                        cursor:     downloadingAll ? "default" : "pointer",
                        opacity:    downloadingAll ? 0.6 : 1,
                    }}
                >
                    {downloadingAll ? "Zipping…" : "⬇ All Grids CSV"}
                </button>
                <button
                    onClick={onToggleGrid}
                    style={{
                        ...btnBase,
                        background: showGrid ? "rgba(0,207,255,0.18)" : "rgba(0,0,0,0.55)",
                        color:      showGrid ? "#00cfff" : "#aaa",
                        border:     `1px solid ${showGrid ? "#00cfff" : "#444"}`,
                        cursor:     "pointer",
                    }}
                >
                    {showGrid ? "⊞ Grid ON" : "⊞ Grid OFF"}
                </button>
            </div>

            <button
                onClick={onToggleBoxDraw}
                title="When ON, click + drag on the map draws a bounding box (Shift not required)"
                style={{
                    ...btnBase,
                    background: boxDrawMode ? "rgba(243,156,18,0.18)" : "rgba(0,0,0,0.55)",
                    color:      boxDrawMode ? "#f39c12" : "#aaa",
                    border:     `1px solid ${boxDrawMode ? "#f39c12" : "#444"}`,
                    cursor:     "pointer",
                }}
            >
                {boxDrawMode ? "✥ Box Mode ON" : "✥ Box Mode OFF"}
            </button>

            {downloadAllError && (
                <div style={{
                    background: "rgba(10,14,26,0.92)", color: "#f87171",
                    fontSize: 11, padding: "4px 10px", borderRadius: 6,
                    border: "1px solid #f8717155", maxWidth: "220px", textAlign: "right",
                }}>
                    {downloadAllError}
                </div>
            )}
        </div>
    );
}

function GridLayer({ stations, selectedGridId, onGridClick, showLabels }) {
    const activeGridIds = useMemo(() => {
        const ids = new Set();
        stations.forEach(s => {
            const lat = Number(s.latitude);
            const lon = Number(s.longitude);
            if (!isNaN(lat) && !isNaN(lon)) {
                const gridId = latLonToGridId(lat, lon);
                if (gridId) ids.add(gridId);
            }
        });
        return ids;
    }, [stations]);

    return (
        <>
            {ALL_GRID_CELLS.map(({ gridId, bounds, centerLat, centerLon })=>{
                const isActive   = activeGridIds.has(gridId);
                const isSelected = gridId === selectedGridId;
                const cellNumber = gridId.split("_")[1];

                const style = isSelected
                    ? GRID_STYLE_SELECTED
                    : isActive
                    ? GRID_STYLE_ACTIVE
                    : GRID_STYLE_DEFAULT;

                return (
                    <Rectangle
                        key={gridId}
                        bounds={bounds}
                        pathOptions={style}
                        eventHandlers={isActive ? { click: () => onGridClick(gridId) } : {}}
                    >
                        {showLabels && (
                        <Marker
                            position={[centerLat, centerLon]}
                            interactive={false}
                            icon={L.divIcon({
                                className: "grid-number",
                                html: `<span>${cellNumber}</span>`,
                                iconSize: [24,24],
                                iconAnchor:[12,12],
                            })}
                        />
                    )}
                    </Rectangle>
                );
            })}
        </>
    );
}

function GridInfoPanel({ gridId, stations, onClose, dateFrom, dateTo }) {
    const [downloading, setDownloading] = useState(false);
    const [error, setError] = useState(null);

    if (!gridId) return null;

    const gridStations = stations.filter(s => {
        const lat = Number(s.latitude);
        const lon = Number(s.longitude);
        return !isNaN(lat) && !isNaN(lon) && latLonToGridId(lat, lon) === gridId;
    });

    const types = [...new Set(gridStations.map(s => s.type?.toUpperCase()).filter(Boolean))];

    const handleDownload = async () => {
        setDownloading(true);
        setError(null);

        const params = new URLSearchParams();

        if (dateFrom)
            params.append("date_from", dateFrom);

        if (dateTo)
            params.append("date_to", dateTo);

        const url =
            `${API_BASE}/grid-csv/${gridId}` +
            (params.toString() ? `?${params}` : "");

        await downloadFromApi(
            url,
            `${gridId}.csv`,
            setError
        );

        setDownloading(false);
    };

    return (
        <div style={{
            position:      "absolute",
            top:           "12px",
            left:          "60px",
            zIndex:        1000,
            background:    "rgba(10,14,26,0.92)",
            border:        "1px solid #00cfff55",
            borderRadius:  "8px",
            padding:       "12px 16px",
            minWidth:      "200px",
            backdropFilter:"blur(6px)",
            color:         "#e2e8f0",
        }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontFamily: "monospace", fontSize: 13, color: "#00cfff", fontWeight: 700 }}>
                    {gridId}
                </span>
                <button
                    onClick={onClose}
                    style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 14 }}
                >✕</button>
            </div>

            <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.8 }}>
                <div>Profiles: <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{gridStations.length}</span></div>
                {types.length > 0 && (
                    <div>Types: <span style={{ color: "#e2e8f0" }}>{types.join(", ")}</span></div>
                )}
            </div>

            {gridStations.length > 0 && (
                <div style={{ marginTop: 10, maxHeight: 140, overflowY: "auto" }}>
                    {gridStations.slice(0, 10).map((s, i) => (
                        <div key={i} style={{
                            fontSize:    10,
                            fontFamily:  "monospace",
                            color:       "#64748b",
                            padding:     "2px 0",
                            borderBottom:"1px solid #1e2d4533",
                        }}>
                            {s.file_name || s.station || `Station ${i + 1}`}
                            <span style={{ marginLeft: 6, color: "#475569" }}>
                                {Number(s.latitude).toFixed(2)}°N {Number(s.longitude).toFixed(2)}°E
                            </span>
                        </div>
                    ))}
                    {gridStations.length > 10 && (
                        <div style={{ fontSize: 10, color: "#475569", marginTop: 4 }}>
                            +{gridStations.length - 10} more…
                        </div>
                    )}
                </div>
            )}

            <button
                type="button"
                onClick={handleDownload}
                disabled={downloading || gridStations.length === 0}
                style={{
                    marginTop:    10,
                    width:        "100%",
                    padding:      "6px 0",
                    background:   "#1a6fa8",
                    color:        "#fff",
                    border:       "none",
                    borderRadius: "5px",
                    fontSize:     "12px",
                    cursor:       downloading ? "default" : "pointer",
                    opacity:      downloading || gridStations.length === 0 ? 0.6 : 1,
                }}
            >
                {downloading ? "Preparing CSV…" : "Download Training CSV"}
            </button>
            {error && (
                <div style={{ fontSize: 10, color: "#f87171", marginTop: 6 }}>{error}</div>
            )}
        </div>
    );
}

function Legend({ activeShip, shipColorMap, ships, onSelectShip, style }) {
    return (
        <aside className="map-legend" style={style}>
            <h3>Ships</h3>
            <button
                className={`legend-filter ${activeShip === "all" ? "active" : ""}`}
                type="button"
                onClick={() => onSelectShip("all")}
            >
                Show All
            </button>

            <div className="legend-items">
                {ships.length === 0 ? (
                    <p>No ships loaded</p>
                ) : (
                    ships.map((ship) => (
                        <button
                            className={`legend-item ${activeShip === ship ? "active" : ""}`}
                            key={ship}
                            type="button"
                            onClick={() => onSelectShip(ship)}
                        >
                            <span style={{ background: shipColorMap[ship] }} />
                            {ship}
                        </button>
                    ))
                )}
            </div>
        </aside>
    );
}

function Navbar() {
    return (
        <div className="navbar">
            <div className="navbar-logo">🌊 OceanGrid</div>
            <div className="navbar-title">CTD Data Visualization</div>
        </div>
    );
}

function InstrumentKey() {
    const items = [
        {
            type: "CTD",
            shape: (
                <svg width="14" height="14" viewBox="0 0 14 14">
                    <circle cx="7" cy="7" r="5.5" fill="#7ec8e3" stroke="rgba(0,0,0,0.4)" strokeWidth="1"/>
                </svg>
            ),
        },
        {
            type: "XBT",
            shape: (
                <svg width="14" height="14" viewBox="0 0 14 14">
                    <polygon points="7,1.5 13,12.5 1,12.5" fill="#7ec8e3" stroke="rgba(0,0,0,0.4)" strokeWidth="1"/>
                </svg>
            ),
        },
        {
            type: "XCTD",
            shape: (
                <svg width="14" height="14" viewBox="0 0 14 14">
                    <polygon points="7,1 13,7 7,13 1,7" fill="#7ec8e3" stroke="rgba(0,0,0,0.4)" strokeWidth="1"/>
                </svg>
            ),
        },
    ];

    return (
        <section className="filter-card">
            <h3>Instrument Types</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "6px" }}>
                {items.map(({ type, shape }) => (
                    <div key={type} style={{ display: "flex", alignItems: "center", gap: "10px", fontSize: "13px", color: "#ccc" }}>
                        {shape}
                        <span>{type}</span>
                    </div>
                ))}
            </div>
            <p style={{ fontSize: "11px", color: "#666", marginTop: "8px", marginBottom: 0 }}>
                Marker color indicates ship
            </p>
        </section>
    );
}

function LoadingStatus({ loadingTypes, error }) {
    const types = ["ctd", "xbt", "xctd"];
    const anyLoading = loadingTypes && Object.values(loadingTypes).some(Boolean);

    if (!anyLoading && !error) return null;

    return (
        <div style={{ padding: "6px 0" }}>
            {types.map(t => {
                const isLoading = loadingTypes?.[t];
                if (!isLoading) return null;
                return (
                    <div key={t} style={{
                        display: "flex", alignItems: "center", gap: "8px",
                        fontSize: "12px", color: "#aaa", padding: "2px 0"
                    }}>
                        <div style={{
                            width: "10px", height: "10px",
                            border: "2px solid #444", borderTop: "2px solid #3498db",
                            borderRadius: "50%",
                            animation: "seasnap-spin 0.75s linear infinite",
                            flexShrink: 0,
                        }}/>
                        Loading {t.toUpperCase()}…
                    </div>
                );
            })}
            {error && <p className="sidebar-status error" style={{ marginTop: "4px" }}>{error}</p>}
            <style>{`@keyframes seasnap-spin { to { transform: rotate(360deg); } }`}</style>
        </div>
    );
}

// TemporalFilter now stages date edits locally and only pushes them up to
// the parent (which re-filters/re-fetches) when "Apply" is clicked — typing
// or picking a date no longer triggers an expensive re-render on every change.
function TemporalFilter({ dateFrom, dateTo, onDateFromChange, onDateToChange, onReset }) {
    const [draftFrom, setDraftFrom] = useState(dateFrom || "");
    const [draftTo,   setDraftTo]   = useState(dateTo || "");

    // Re-sync drafts whenever the committed values change underneath us
    // (e.g. after Reset, or if changed elsewhere in the app).
    useEffect(() => {
        setDraftFrom(dateFrom || "");
        setDraftTo(dateTo || "");
    }, [dateFrom, dateTo]);

    const isDirty = draftFrom !== (dateFrom || "") || draftTo !== (dateTo || "");

    const handleApply = () => {
        onDateFromChange(draftFrom);
        onDateToChange(draftTo);
    };

    const handleReset = () => {
        setDraftFrom("");
        setDraftTo("");
        onReset();
    };

    return (
        <section className="filter-card">
            <div className="filter-header">
                <h3>Time Range</h3>
                <button type="button" className="reset-btn" onClick={handleReset}>Reset</button>
            </div>
            <label className="filter-label">
                <span>From</span>
                <input type="date" value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)} />
            </label>
            <label className="filter-label">
                <span>To</span>
                <input type="date" value={draftTo} onChange={(e) => setDraftTo(e.target.value)} />
            </label>
            <button
                type="button"
                onClick={handleApply}
                disabled={!isDirty}
                style={{
                    marginTop:    8,
                    width:        "100%",
                    padding:      "6px 0",
                    background:   isDirty ? "#1a6fa8" : "rgba(255,255,255,0.06)",
                    color:        isDirty ? "#fff" : "#64748b",
                    border:       isDirty ? "none" : "1px solid #334155",
                    borderRadius: "5px",
                    fontSize:     "12px",
                    cursor:       isDirty ? "pointer" : "default",
                }}
            >
                Apply Time Range
            </button>
        </section>
    );
}

// SpatialBounds now doubles as the manual bounding-box entry form:
// - Dragging a box on the map (Shift+drag, or Box Mode) auto-fills these
//   fields via the `bounds` prop.
// - Typing coordinates directly and pressing "Apply Bounding Box" sets the
//   same spatial filter without touching the map at all.
function SpatialBounds({ bounds, onApply, onClear }) {
    const [latMin, setLatMin] = useState("");
    const [latMax, setLatMax] = useState("");
    const [lonMin, setLonMin] = useState("");
    const [lonMax, setLonMax] = useState("");
    const [formError, setFormError] = useState(null);

    // Auto-fill from a mouse-drawn box.
    useEffect(() => {
        if (bounds) {
            setLatMin(bounds.latMin.toFixed(4));
            setLatMax(bounds.latMax.toFixed(4));
            setLonMin(bounds.lonMin.toFixed(4));
            setLonMax(bounds.lonMax.toFixed(4));
            setFormError(null);
        }
    }, [bounds]);

    const handleApply = () => {
        const parsed = {
            latMin: parseFloat(latMin),
            latMax: parseFloat(latMax),
            lonMin: parseFloat(lonMin),
            lonMax: parseFloat(lonMax),
        };
        if (Object.values(parsed).some((v) => Number.isNaN(v))) {
            setFormError("All four fields are required.");
            return;
        }
        if (parsed.latMin >= parsed.latMax) {
            setFormError("Lat min must be less than lat max.");
            return;
        }
        if (parsed.lonMin >= parsed.lonMax) {
            setFormError("Lon min must be less than lon max.");
            return;
        }
        setFormError(null);
        onApply(parsed);
    };

    const handleClear = () => {
        setLatMin("");
        setLatMax("");
        setLonMin("");
        setLonMax("");
        setFormError(null);
        onClear();
    };

    return (
        <section className={`filter-card${bounds ? " active-bounds" : ""}`}>
            <div className="filter-header">
                <h3>Spatial Filter</h3>
                <button type="button" className="reset-btn" onClick={handleClear} disabled={!bounds}>
                    Clear
                </button>
            </div>

            <p className="hint-text" style={{ marginTop: 0, marginBottom: 8 }}>
                Draw on the map (Shift+drag, or Box Mode) — or enter coordinates directly below.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 10px" }}>
                <label className="filter-label">
                    <span>Lat Min</span>
                    <input
                        style={boxInputStyle} type="number" step="0.0001"
                        value={latMin} onChange={(e) => setLatMin(e.target.value)}
                        placeholder="-70"
                    />
                </label>
                <label className="filter-label">
                    <span>Lat Max</span>
                    <input
                        style={boxInputStyle} type="number" step="0.0001"
                        value={latMax} onChange={(e) => setLatMax(e.target.value)}
                        placeholder="30"
                    />
                </label>
                <label className="filter-label">
                    <span>Lon Min</span>
                    <input
                        style={boxInputStyle} type="number" step="0.0001"
                        value={lonMin} onChange={(e) => setLonMin(e.target.value)}
                        placeholder="20"
                    />
                </label>
                <label className="filter-label">
                    <span>Lon Max</span>
                    <input
                        style={boxInputStyle} type="number" step="0.0001"
                        value={lonMax} onChange={(e) => setLonMax(e.target.value)}
                        placeholder="120"
                    />
                </label>
            </div>

            {formError && (
                <p style={{ color: "#f87171", fontSize: 11, marginTop: 6, marginBottom: 0 }}>{formError}</p>
            )}

            <button
                type="button"
                onClick={handleApply}
                style={{
                    marginTop:    8,
                    width:        "100%",
                    padding:      "6px 0",
                    background:   "#1a6fa8",
                    color:        "#fff",
                    border:       "none",
                    borderRadius: "5px",
                    fontSize:     "12px",
                    cursor:       "pointer",
                }}
            >
                Apply Bounding Box
            </button>

        </section>
    );
}

function Sidebar({
    stationCount,
    filteredCount,
    query,
    setQuery,
    loading,
    error,
    onRefresh,
    dateFrom,
    dateTo,
    onDateFromChange,
    onDateToChange,
    onDateReset,
    spatialBounds,
    onSpatialBoundsChange,
    onSpatialClear,
    loadingTypes,
}) {
    return (
        <aside className="dashboard-sidebar">
            <div className="sidebar-panel">
                <h2>OceanGrid</h2>

                <section className="search-card">
                    <label>
                        <span>Search stations</span>
                        <input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Ship, station, cruise, file..."
                        />
                    </label>
                    <div className="count-row">
                        <strong>{filteredCount}</strong>
                        <span>shown of {stationCount}</span>
                    </div>
                    <button type="button" onClick={onRefresh} disabled={loading}>
                        {loading ? "Loading..." : "Refresh Stations"}
                    </button>
                </section>

                <LoadingStatus loadingTypes={loadingTypes} error={error} />
                <InstrumentKey />
                <TemporalFilter
                    dateFrom={dateFrom}
                    dateTo={dateTo}
                    onDateFromChange={onDateFromChange}
                    onDateToChange={onDateToChange}
                    onReset={onDateReset}
                />
                <SpatialBounds
                    bounds={spatialBounds}
                    onApply={onSpatialBoundsChange}
                    onClear={onSpatialClear}
                />
            </div>
        </aside>
    );
}

export function MapView({
    stations = [],
    onSelectStation,
    spatialBounds,
    onSpatialBoundsChange,
    query,
    setQuery,
    loading,
    error,
    onRefresh,
    loadingTypes,
    dateFrom,
    dateTo,
    onDateFromChange,
    onDateToChange,
    onDateReset,
    onSpatialClear,
}) {
    const [activeShip,      setActiveShip]      = useState("all");
    const [eezLoops,        setEezLoops]        = useState([]);
    const [previewBox,      setPreviewBox]       = useState(null);
    const [showGrid,        setShowGrid]        = useState(true);
    const [selectedGridId,  setSelectedGridId]  = useState(null);
    const [zoomLevel,       setZoomLevel]       = useState(4);
    const [downloadingAll,  setDownloadingAll]  = useState(false);
    const [downloadAllError, setDownloadAllError] = useState(null);
    const [boxDrawMode,     setBoxDrawMode]     = useState(false);

    const showGridLabels = zoomLevel >= 5;

    useEffect(() => {
        fetch("/data/india_eez.geojson")
            .then(res => res.json())
            .then(data => setEezLoops(extractEEZLoops(data)))
            .catch(err => console.error("Failed to load EEZ GeoJSON:", err));
    }, []);

    const shipColorMap = useMemo(() => { return generateShipColorMap(stations);}, [stations]);
    const ships        = Object.keys(shipColorMap);

    const filteredStations = useMemo(() => {

        if (activeShip === "all")
            return stations;

        return stations.filter(
            s => s.ship === activeShip
        );

    }, [stations, activeShip]);

    const handleBoxChange = useCallback((bounds, phase) => {
        if (phase === "drawing") {
            setPreviewBox(bounds);
        } else {
            setPreviewBox(null);
            onSpatialBoundsChange(bounds);
        }
    }, [onSpatialBoundsChange]);

    const handleGridClick = useCallback((gridId) => {
        setSelectedGridId(prev => prev === gridId ? null : gridId);
    }, []);

    const handleDownloadAllGrids = useCallback(async () => {
        setDownloadingAll(true);
        setDownloadAllError(null);

        const params = new URLSearchParams();

        if (dateFrom)
            params.append("date_from", dateFrom);

        if (dateTo)
            params.append("date_to", dateTo);

        const url =
            `${API_BASE}/grid-csv-all` +
            (params.toString() ? `?${params}` : "");

        await downloadFromApi(
            url,
            "oceangrid_training_data.zip",
            setDownloadAllError
        );

        setDownloadingAll(false);
    }, [dateFrom, dateTo]);

    const toPositions = (b) =>
        b ? [[b.latMin, b.lonMin], [b.latMax, b.lonMax]] : null;

    return (
        <div className="app-container">
            <Navbar />
            <div className="main-layout">
                <Sidebar
                    stationCount={stations.length}
                    filteredCount={filteredStations.length}
                    query={query}
                    setQuery={setQuery}
                    loading={loading}
                    error={error}
                    onRefresh={onRefresh}
                    dateFrom={dateFrom}
                    dateTo={dateTo}
                    onDateFromChange={onDateFromChange}
                    onDateToChange={onDateToChange}
                    onDateReset={onDateReset}
                    spatialBounds={spatialBounds}
                    onSpatialBoundsChange={onSpatialBoundsChange}
                    onSpatialClear={onSpatialClear}
                    loadingTypes={loadingTypes}
                />

                <div className="map-container">
                    <div style={{ height: "100%", position: "relative" }}>
                        <MapContainer center={[12, 85]} zoom={4} style={{ height: "100%", width: "100%" }}>
                            <TileLayer
                                attribution="Tiles &copy; Esri"
                                url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                            />

                            <BoxSelectHandler onBoundsChange={handleBoxChange} boxDrawMode={boxDrawMode} />
                            <ZoomWatcher onZoomChange={setZoomLevel} />

                            {eezLoops.map((loop, idx) => (
                                <Polyline key={idx} positions={loop} pathOptions={EEZ_STYLE} />
                            ))}

                            {showGrid && (
                                <GridLayer
                                    stations={filteredStations}
                                    selectedGridId={selectedGridId}
                                    onGridClick={handleGridClick}
                                    showLabels={showGridLabels}
                                />
                            )}

                            {toPositions(spatialBounds) && (
                                <Rectangle bounds={toPositions(spatialBounds)} pathOptions={BOX_STYLE} />
                            )}
                            {toPositions(previewBox) && (
                                <Rectangle
                                    bounds={toPositions(previewBox)}
                                    pathOptions={{ ...BOX_STYLE, opacity: 0.4, fillOpacity: 0.04 }}
                                />
                            )}

                            {filteredStations.map((station, index) => {
                                const lat = Number(station.latitude);
                                const lon = Number(station.longitude);
                                if (isNaN(lat) || isNaN(lon)) return null;

                                const color = shipColorMap[station.ship] || "#3498db";
                                const icon  = makeInstrumentIcon(station.type, color);

                                return (
                                    <Marker
                                        key={`${station.type}-${index}`}
                                        position={[lat, lon]}
                                        icon={icon}
                                        eventHandlers={{ click: () => onSelectStation(station) }}
                                    >
                                        <Popup>
                                            <div className="popup-content">
                                                <p><b>Instrument:</b> {station.type?.toUpperCase()}</p>
                                                <p><b>Ship:</b> {station.ship}</p>
                                                <p><b>Cruise:</b> {station.cruise}</p>
                                                <p><b>Station:</b> {station.station}</p>
                                                <p><b>Datetime:</b> {station.datetime}</p>
                                                <p><b>Depth:</b> {station.depth}</p>
                                                <p><b>Lat:</b> {lat.toFixed(4)}</p>
                                                <p><b>Lon:</b> {lon.toFixed(4)}</p>
                                                <p><b>Grid:</b> <span style={{ color: "#00cfff", fontFamily: "monospace" }}>{latLonToGridId(lat, lon)}</span></p>
                                            </div>
                                        </Popup>
                                    </Marker>
                                );
                            })}
                        </MapContainer>

                        <ShiftDragHint spatialBounds={spatialBounds} boxDrawMode={boxDrawMode} />

                        <MapControls
                            showGrid={showGrid}
                            onToggleGrid={() => {
                                setShowGrid(p => !p);
                                if (showGrid) setSelectedGridId(null);
                            }}
                            onDownloadAll={handleDownloadAllGrids}
                            downloadingAll={downloadingAll}
                            downloadAllError={downloadAllError}
                            boxDrawMode={boxDrawMode}
                            onToggleBoxDraw={() => setBoxDrawMode(p => !p)}
                        />

                        {selectedGridId && (
                            <GridInfoPanel
                                gridId={selectedGridId}
                                stations={filteredStations}
                                onClose={() => setSelectedGridId(null)}
                                dateFrom={dateFrom}
                                dateTo={dateTo}
                            />
                        )}

                        <Legend
                            activeShip={activeShip}
                            shipColorMap={shipColorMap}
                            ships={ships}
                            onSelectShip={setActiveShip}
                            style={{
                                position: "absolute",
                                top:      "auto",
                                bottom:   "24px",
                                right:    "12px",
                                left:     "auto",
                                zIndex:   900,
                            }}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}

export { Legend, Navbar, Sidebar };
export default MapView;