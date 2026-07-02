from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

import os
import re
import io
import zipfile
import sqlite3
import pandas as pd

from meta_processor import infer_ship_from_metadata


# ==========================================
# FASTAPI SETUP
# ==========================================

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==========================================
# DIRECTORIES
# ==========================================

BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)
DATA_DIR    = os.path.join(PROJECT_ROOT, "data")
CACHE_DIR = os.path.abspath(
    os.path.join(BASE_DIR, "cache")
)

os.makedirs(CACHE_DIR, exist_ok=True)

CACHE_DB = os.path.join(
    CACHE_DIR,
    "cache_profiles.sqlite"
)

print("CACHE_DB =", CACHE_DB)

# ==========================================
# INSTRUMENT CONFIG
# ==========================================
# column_map  : raw CSV column -> canonical name
# output_columns : canonical columns stored in SQLite and returned by /profile
#
# NOTE: "Pres_dbar" was added to every instrument below so the grid CSV
# export has real pressure values to work with (previously only Pres_QC,
# the QC flag, was cached — not the pressure reading itself).

INSTRUMENT_CONFIG: dict[str, dict] = {
    "ctd": {
        "data_folder": os.environ.get(
            "SEASNAP_CTD_DATA_FOLDER",
            "/home/ishitha/CTD/",
        ),
        "meta_folder": os.environ.get(
            "SEASNAP_CTD_META_FOLDER",
            "/home/ishitha/CTD/metadata/",
        ),
        "table": "profiles_ctd",
        "column_map": {
            "Depth (m)":           "depSM",
            "depSM":               "depSM",
            "Pres (dbar)":         "Pres_dbar",
            "Temp-90 (deg C)":     "TEMP_QC_VAR",
            "t090C":               "TEMP_QC_VAR",
            "TEMP_QC_VAR":         "TEMP_QC_VAR",
            "Sal00 (psu)":         "SAL_QC_VAR",
            "Sal00":               "SAL_QC_VAR",
            "SAL_QC_VAR":          "SAL_QC_VAR",
            "Conductivity (S/m)":  "c0S/m",
            "c0S/m":               "c0S/m",
            "Sigma-t":             "sigma-t00",
            "sigma-t00":           "sigma-t00",
            "DO (ml/l)":           "sbeox0ML/L",
            "sbeox0ML/L":          "sbeox0ML/L",
            "SourceFile":          "SourceFile",
            "folderpath_filename": "SourceFile",
            "Temp_QC":             "Temp_QC",
            "Sal_QC":              "Sal_QC",
            "Pres_QC":             "Pres_QC",
            "ALL_TESTS_QC":        "ALL_TESTS_QC",
        },
        "output_columns": [
            "depSM", "Pres_dbar", "TEMP_QC_VAR", "Temp_QC",
            "SAL_QC_VAR", "Sal_QC", "c0S/m",
            "sigma-t00", "sbeox0ML/L", "Pres_QC", "ALL_TESTS_QC",
        ],
    },

    "xbt": {
        "data_folder": os.environ.get(
            "SEASNAP_XBT_DATA_FOLDER",
            "/home/ishitha/XBT/",
        ),
        "meta_folder": os.environ.get(
            "SEASNAP_XBT_META_FOLDER",
            "/home/ishitha/XBT/metadata/",
        ),
        "table": "profiles_xbt",
        "column_map": {
            "Depth (m)":           "depSM",
            "Pres (dbar)":         "Pres_dbar",
            "Temperature (deg C)": "TEMP_QC_VAR",
            "TEMP_QC_VAR":         "TEMP_QC_VAR",
            "Temp_QC":             "Temp_QC",
            "Pres_QC":             "Pres_QC",
            "SourceFile":          "SourceFile",
            "ALL_TESTS_QC":        "ALL_TESTS_QC",
        },
        "output_columns": [
            "depSM", "Pres_dbar", "TEMP_QC_VAR", "Temp_QC", "Pres_QC", "ALL_TESTS_QC",
        ],
    },

    "xctd": {
        "data_folder": os.environ.get(
            "SEASNAP_XCTD_DATA_FOLDER",
            "/home/ishitha/XCTD/",
        ),
        "meta_folder": os.environ.get(
            "SEASNAP_XCTD_META_FOLDER",
            "/home/ishitha/XCTD/metadata/",
        ),
        "table": "profiles_xctd",
        "column_map": {
            "Depth (m)":           "depSM",
            "Pres (dbar)":         "Pres_dbar",
            "Temperature (deg C)": "TEMP_QC_VAR",
            "TEMP_QC_VAR":         "TEMP_QC_VAR",
            "Salinity (psu)":      "SAL_QC_VAR",
            "SAL_QC_VAR":          "SAL_QC_VAR",
            "Temp_QC":             "Temp_QC",
            "Sal_QC":              "Sal_QC",
            "Pres_QC":             "Pres_QC",
            "SourceFile":          "SourceFile",
            "ALL_TESTS_QC":        "ALL_TESTS_QC",
        },
        "output_columns": [
            "depSM", "Pres_dbar", "TEMP_QC_VAR", "Temp_QC",
            "SAL_QC_VAR", "Sal_QC", "Pres_QC", "ALL_TESTS_QC",
        ],
    },
}

# Full union of columns — /profile always returns this shape;
# columns not produced by a given instrument are filled with None.
ALL_OUTPUT_COLUMNS = [
    "depSM", "Pres_dbar", "TEMP_QC_VAR", "Temp_QC",
    "SAL_QC_VAR", "Sal_QC", "c0S/m",
    "sigma-t00", "sbeox0ML/L", "Pres_QC", "ALL_TESTS_QC",
]

QC_COLUMNS = {"Temp_QC", "Sal_QC", "Pres_QC", "ALL_TESTS_QC"}

# Bump this whenever INSTRUMENT_CONFIG's column_map/output_columns change shape —
# it forces a one-time cache rebuild instead of silently reusing a stale schema.
CACHE_SCHEMA_VERSION = "2"

# In-memory station cache: instrument_type -> list[dict]
_station_cache: dict[str, list[dict]] = {}


# ==========================================
# FOLDER HELPERS
# ==========================================

def _csv_files(folder: str) -> list[str]:
    """Sorted list of .csv paths in folder."""
    return sorted(
        os.path.join(folder, f)
        for f in os.listdir(folder)
        if f.endswith(".csv")
    )


def _resolve_folder(instrument_type: str) -> str:
    """Return a valid data folder for the instrument, or raise."""
    cfg = INSTRUMENT_CONFIG[instrument_type]
    candidates = [
        cfg["data_folder"],
        os.path.join(DATA_DIR, instrument_type),
        os.path.join(PROJECT_ROOT, instrument_type),
    ]
    for path in candidates:
        if path and os.path.isdir(path) and _csv_files(path):
            return path
    raise FileNotFoundError(
        f"{instrument_type.upper()} data folder not found or has no CSVs. "
        f"Set SEASNAP_{instrument_type.upper()}_DATA_FOLDER."
    )


def _folder_mtime(folder: str) -> float:
    """Latest mtime across all CSVs in folder."""
    files = _csv_files(folder)
    return max((os.path.getmtime(f) for f in files), default=0.0)


# ==========================================
# SQLITE CACHE HELPERS
# ==========================================

def _meta_key(instrument_type: str, key: str) -> str:
    return f"{instrument_type}:{key}"


def _cache_is_current(instrument_type: str, folder: str) -> bool:
    if not os.path.isfile(CACHE_DB):
        return False
    latest = _folder_mtime(folder)
    try:
        with sqlite3.connect(CACHE_DB) as conn:
            rows = dict(conn.execute("SELECT key, value FROM metadata").fetchall())
    except sqlite3.OperationalError:
        return False
    return (
        rows.get(_meta_key(instrument_type, "source_path")) == folder
        and float(rows.get(_meta_key(instrument_type, "source_mtime"), 0)) == latest
        and rows.get(_meta_key(instrument_type, "schema_version")) == CACHE_SCHEMA_VERSION
    )


def _build_cache(instrument_type: str, folder: str) -> None:
    cfg = INSTRUMENT_CONFIG[instrument_type]

    table        = cfg["table"]
    column_map   = cfg["column_map"]
    out_cols     = cfg["output_columns"]
    usecols_set  = set(column_map.keys())

    csv_files    = _csv_files(folder)
    latest_mtime = _folder_mtime(folder)

    os.makedirs(CACHE_DIR, exist_ok=True)

    print(
        f"[{instrument_type}] Building cache from "
        f"{len(csv_files)} file(s) in: {folder}"
    )

    col_defs = ", ".join(
        f'"{c}" {"INTEGER" if c in QC_COLUMNS else "REAL"}'
        for c in out_cols
    )

    with sqlite3.connect(CACHE_DB) as conn:

        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA temp_store=MEMORY")
        conn.execute("PRAGMA cache_size=-100000")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )

        conn.execute(f"DROP TABLE IF EXISTS {table}")

        conn.execute(
            f"""
            CREATE TABLE {table} (
                stem TEXT NOT NULL,
                {col_defs}
            )
            """
        )

        total_rows = 0

        for csv_path in csv_files:

            fname = os.path.basename(csv_path)

            print(f"[{instrument_type}] Reading {fname}")

            file_rows = 0

            for chunk in pd.read_csv(
                csv_path,
                usecols=lambda c: c.strip() in usecols_set,
                chunksize=200_000,      # increased from 100k
                low_memory=False,
            ):

                chunk.columns = chunk.columns.str.strip()

                chunk = chunk.rename(columns=column_map)

                chunk = chunk.loc[
                    :,
                    ~chunk.columns.duplicated(keep="last")
                ]

                if "SourceFile" not in chunk.columns:
                    raise ValueError(
                        f"No SourceFile column in {csv_path}"
                    )

                chunk["stem"] = (
                    chunk["SourceFile"]
                    .astype(str)
                    .str.rsplit(".", n=1)
                    .str[0]
                    .str.strip()
                    .str.lower()
                )

                chunk = chunk.reindex(
                    columns=["stem"] + out_cols
                )

                for col in out_cols:
                    chunk[col] = pd.to_numeric(
                        chunk[col],
                        errors="coerce"
                    )

                chunk = chunk.dropna(
                    subset=["stem", "depSM"]
                )

                rows = len(chunk)

                chunk.to_sql(
                    table,
                    conn,
                    if_exists="append",
                    index=False,
                    method="multi",
                    chunksize=5000,
                )

                file_rows += rows
                total_rows += rows

            print(
                f"  {fname}: "
                f"{file_rows:,} rows "
                f"(total {total_rows:,})"
            )

        print(
            f"[{instrument_type}] Creating stem index..."
        )

        conn.execute(
            f"""
            CREATE INDEX IF NOT EXISTS
            idx_{table}_stem
            ON {table}(stem)
            """
        )

        count = conn.execute(
            f"SELECT COUNT(*) FROM {table}"
        ).fetchone()[0]

        print(
            f"[{instrument_type}] "
            f"Table rows verified: {count:,}"
        )

        conn.execute(
            """
            INSERT OR REPLACE INTO metadata
            VALUES (?, ?)
            """,
            (
                _meta_key(
                    instrument_type,
                    "source_path"
                ),
                folder,
            ),
        )

        conn.execute(
            """
            INSERT OR REPLACE INTO metadata
            VALUES (?, ?)
            """,
            (
                _meta_key(
                    instrument_type,
                    "source_mtime"
                ),
                str(latest_mtime),
            ),
        )

        conn.execute(
            """
            INSERT OR REPLACE INTO metadata
            VALUES (?, ?)
            """,
            (
                _meta_key(
                    instrument_type,
                    "schema_version"
                ),
                CACHE_SCHEMA_VERSION,
            ),
        )

    print(
        f"[{instrument_type}] "
        f"Cache ready: {total_rows:,} rows."
    )


def ensure_cache(instrument_type: str) -> str:

    folder = _resolve_folder(instrument_type)

    current = _cache_is_current(
        instrument_type,
        folder
    )

    print(
        f"[{instrument_type}] "
        f"Cache current = {current}"
    )

    if not current:
        _build_cache(
            instrument_type,
            folder
        )
    else:
        print(
            f"[{instrument_type}] "
            f"Cache is current."
        )

    return folder



# ==========================================
# METADATA LOADING
# ==========================================

_META_RENAME = {
    "Latitude(decimal)":   "Latitude_decimal",
    "Latitude (decimal)":  "Latitude_decimal",
    "Longitude(decimal)":  "Longitude_decimal",
    "Longitude (decimal)": "Longitude_decimal",
    "Depth":               "Station Depth",
    "Station":             "Station Number",
}

_COALESCE_COLS = ["Latitude_decimal", "Longitude_decimal", "Station Depth", "Station Number"]


def _resolve_meta_folder(instrument_type: str) -> str:
    cfg = INSTRUMENT_CONFIG[instrument_type]
    candidates = [
        cfg["meta_folder"],
        os.path.join(PROJECT_ROOT, "meta", instrument_type),
        os.path.join(BASE_DIR,     "meta", instrument_type),
    ]
    for path in candidates:
        if path and os.path.isdir(path):
            return path
    return cfg["meta_folder"]  # let caller handle missing


def _load_meta_df(instrument_type: str) -> tuple[pd.DataFrame, str, str | None]:
    """Load, clean and return the metadata DataFrame for one instrument."""
    meta_folder = _resolve_meta_folder(instrument_type)

    if not os.path.isdir(meta_folder):
        return pd.DataFrame(), meta_folder, "Meta folder not found"

    csv_files = [
        os.path.join(meta_folder, f)
        for f in os.listdir(meta_folder)
        if f.endswith(".csv")
    ]
    if not csv_files:
        return pd.DataFrame(), meta_folder, "No CSV files found"

    frames = []
    for path in csv_files:
        try:
            frames.append(pd.read_csv(path))
        except Exception as e:
            print(f"[{instrument_type}] Failed to read {path}: {e}")

    if not frames:
        return pd.DataFrame(), meta_folder, "No valid CSV files"

    df = pd.concat(frames, ignore_index=True).rename(columns=_META_RENAME)

    # Coalesce duplicate columns (e.g. two "Latitude_decimal" after rename)
    for col in _COALESCE_COLS:
        dupes = df.loc[:, df.columns == col]
        if dupes.shape[1] > 1:
            merged = dupes.bfill(axis=1).iloc[:, 0]
            df = df.loc[:, ~df.columns.duplicated()]
            df[col] = merged

    if "Latitude_decimal" not in df.columns or "Longitude_decimal" not in df.columns:
        return pd.DataFrame(), meta_folder, "Lat/Lon columns missing"

    df["Latitude_decimal"]  = pd.to_numeric(df["Latitude_decimal"],  errors="coerce")
    df["Longitude_decimal"] = pd.to_numeric(df["Longitude_decimal"], errors="coerce")
    df = df.dropna(subset=["Latitude_decimal", "Longitude_decimal"])
    df = df[
        df["Latitude_decimal"].between(-90, 90) &
        df["Longitude_decimal"].between(-180, 180)
    ]

    print(f"[{instrument_type}] Valid stations: {len(df)}")
    return df, meta_folder, None


def _df_to_stations(df: pd.DataFrame, instrument_type: str) -> list[dict]:
    stations = []
    for row in df.itertuples(index=False):
        try:
            raw_file  = getattr(row, "SourceFile", "")
            file_name = (
                str(raw_file)
                if pd.notna(raw_file) and str(raw_file).strip()
                else "N/A"
            )
            source_raw   = str(getattr(row, "SourceFolder", "N/A"))
            source_clean = source_raw.replace(".csv", "").replace("combined_metadata_", "")

            stations.append({
                "type":        instrument_type,
                "latitude":    float(row.Latitude_decimal),
                "longitude":   float(row.Longitude_decimal),
                "ship":        infer_ship_from_metadata(row._asdict()),
                "cruise":      str(getattr(row, "Cruise",          "N/A")),
                "station":     str(getattr(row, "Station Number",  "N/A")),
                "datetime":    str(getattr(row, "Datetime",        "N/A")),
                "depth":       str(getattr(row, "Station Depth",   "N/A")),
                "source":      source_clean,
                "file_name":   file_name,
                "folder_path": file_name,
            })
        except Exception as e:
            print(f"[{instrument_type}] Skipping row: {e}")
    return stations

class SpatialBox(BaseModel):
    latMin: float
    latMax: float
    lonMin: float
    lonMax: float
    
def _stations_in_box(box: SpatialBox):
    stations = []
    for instrument_type in ["ctd", "xbt", "xctd"]:
        # Only use already-cached data — don't block on loading
        # If cache is empty, those stations simply won't appear in spatial results
        for station in _station_cache.get(instrument_type, []):
            lat = float(station["latitude"])
            lon = float(station["longitude"])
            if (box.latMin <= lat <= box.latMax and
                box.lonMin <= lon <= box.lonMax):
                stations.append(station)
    return stations


# ==========================================
# 5x5 GRID CONFIG
# Mirrors GRID_SIZE / GRID_LAT_MIN / GRID_LAT_MAX / GRID_LON_MIN / GRID_LON_MAX
# and latLonToGridId() in MapView.jsx. Keep both definitions in sync if the
# bounding box ever changes.
# ==========================================

GRID_SIZE     = 5
GRID_LAT_MIN  = -70
GRID_LAT_MAX  = 30
GRID_LON_MIN  = 20
GRID_LON_MAX  = 120
GRID_COLS     = int((GRID_LON_MAX - GRID_LON_MIN) / GRID_SIZE)  # 20
GRID_ROWS     = int((GRID_LAT_MAX - GRID_LAT_MIN) / GRID_SIZE)  # 20
GRID_CELL_COUNT = GRID_COLS * GRID_ROWS  # 400


def _valid_grid_id(grid_id: str) -> bool:
    if not grid_id.startswith("Grid_"):
        return False
    try:
        n = int(grid_id.split("_")[1])
    except (IndexError, ValueError):
        return False
    return 1 <= n <= GRID_CELL_COUNT


def grid_id_to_box(grid_id: str) -> SpatialBox:
    """Inverse of latLonToGridId() in MapView.jsx."""
    n = int(grid_id.split("_")[1]) - 1
    row_from_top = n // GRID_COLS
    col = n % GRID_COLS
    lat_max = GRID_LAT_MAX - row_from_top * GRID_SIZE
    lat_min = lat_max - GRID_SIZE
    lon_min = GRID_LON_MIN + col * GRID_SIZE
    lon_max = lon_min + GRID_SIZE
    return SpatialBox(latMin=lat_min, latMax=lat_max, lonMin=lon_min, lonMax=lon_max)


def _season_from_month(month: int) -> str:
    """Indian Ocean monsoon-based seasons."""
    if month in (12, 1, 2):
        return "Winter_Monsoon"
    if month in (3, 4, 5):
        return "Pre_Monsoon"
    if month in (6, 7, 8):
        return "SW_Monsoon"
    return "Post_Monsoon"


def _grid_training_rows( grid_id: str, start_year: int | None = None, end_year: int | None = None, ) -> list[dict]:

    box = grid_id_to_box(grid_id)
    stations = _stations_in_box(box)

    rows = []

    print("CACHE_DB =", CACHE_DB)
    print("Exists:", os.path.exists(CACHE_DB) if CACHE_DB else "CACHE_DB is None")

    with sqlite3.connect(CACHE_DB) as conn:

        conn.row_factory = sqlite3.Row

        for station in stations:

            instrument_type = station["type"]

            stem = (
                station["file_name"]
                .strip()
                .rsplit(".", 1)[0]
                .lower()
            )

            cfg = INSTRUMENT_CONFIG[instrument_type]

            table = cfg["table"]
            out_cols = cfg["output_columns"]

            col_list = ", ".join(f'"{c}"' for c in out_cols)

            profile_rows = conn.execute(
                f"""
                SELECT {col_list}
                FROM {table}
                WHERE stem = ?
                ORDER BY depSM
                """,
                (stem,),
            ).fetchall()

            dt = pd.to_datetime(
                station.get("datetime"),
                errors="coerce"
            )

            # Apply temporal filtering BEFORE loading profile rows
            if pd.notna(dt):
                year = dt.year

                if start_year is not None and year < start_year:
                    continue

                if end_year is not None and year > end_year:
                    continue

            for r in profile_rows:

                rows.append({

                    "grid_id": grid_id,

                    "file_name": station["file_name"],

                    "date": (
                        dt.strftime("%Y-%m-%d")
                        if pd.notna(dt)
                        else None
                    ),

                    "latitude": station["latitude"],

                    "longitude": station["longitude"],

                    "depth": r["depSM"],

                   "pressure": r["Pres_dbar"] if "Pres_dbar" in r.keys() else None,

                    "temperature": r["TEMP_QC_VAR"] if "TEMP_QC_VAR" in r.keys() else None,

                    "salinity": r["SAL_QC_VAR"] if "SAL_QC_VAR" in r.keys() else None,

                    "temp_qc": r["Temp_QC"] if "Temp_QC" in r.keys() else None,

                    "psal_qc": r["Sal_QC"] if "Sal_QC" in r.keys() else None,
                })

    return rows


GRID_CSV_COLUMNS = [
    "grid_id", "file_name", "date", "latitude", "longitude", "depth", 
    "pressure", "temperature", "salinity", "temp_qc", "psal_qc",
]


def _build_grid_training_df(grid_id: str, start_year: int | None = None, end_year: int | None = None, ) -> pd.DataFrame:

    rows = _grid_training_rows( grid_id, start_year, end_year,)

    if not rows:
        return pd.DataFrame(columns=GRID_CSV_COLUMNS)

    df = pd.DataFrame(rows)

    return df[GRID_CSV_COLUMNS]


def _df_to_csv_bytes(df: pd.DataFrame) -> bytes:
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    return buf.getvalue().encode("utf-8")




@app.on_event("startup")
def startup():
    print("=" * 60)
    print("Initializing SQLite cache...")
    print("=" * 60)

    os.makedirs(CACHE_DIR, exist_ok=True)

    for instrument in INSTRUMENT_CONFIG:
        try:
            ensure_cache(instrument)
        except Exception as e:
            print(f"[{instrument}] Cache initialization failed: {e}")

    print("Startup complete.")

# ==========================================
# API ENDPOINTS
# ==========================================

def _validate_type(instrument_type: str) -> None:
    if instrument_type not in INSTRUMENT_CONFIG:
        raise HTTPException(status_code=400, detail=f"Unknown instrument type: '{instrument_type}'")


@app.post("/load-meta")
def load_meta(type: str = Query("ctd")):
    instrument_type = type.lower()
    _validate_type(instrument_type)

    df, meta_folder, error = _load_meta_df(instrument_type)
    if error:
        _station_cache[instrument_type] = []
        raise HTTPException(status_code=500, detail=error)

    stations = _df_to_stations(df, instrument_type)
    _station_cache[instrument_type] = stations

    return {
        "type":        instrument_type,
        "count":       len(stations),
        "message":     "Metadata loaded successfully",
        "meta_folder": meta_folder,
    }


@app.get("/stations")
def get_stations(type: str = Query("ctd")):
    instrument_type = type.lower()
    _validate_type(instrument_type)

    # Auto-load if not yet in cache
    if instrument_type not in _station_cache:
        load_meta(type=instrument_type)

    return {"stations": _station_cache.get(instrument_type, [])}

@app.get("/profile/{station_file:path}")
def get_profile(station_file: str, type: str = Query(None)):
    station_file = station_file.strip()
    stem = re.sub(r"_metadata\.csv$", "", station_file, flags=re.IGNORECASE)
    stem = stem.rsplit(".", 1)[0].strip().lower()

    # If type is explicitly given, search ONLY that table — no fallthrough.
    # Fallthrough across instrument types is what caused stem collisions
    # (e.g. 1107 present in both xbt and xctd tables).
    if type and type.lower() in INSTRUMENT_CONFIG:
        search_types = [type.lower()]
    else:
        # No type given: search all, but in a fixed priority order
        search_types = ["ctd", "xbt", "xctd"]

    for instrument_type in search_types:
        cfg      = INSTRUMENT_CONFIG[instrument_type]
        table    = cfg["table"]
        out_cols = cfg["output_columns"]
        col_list = ", ".join(f'"{c}"' for c in out_cols)
        query    = f'SELECT {col_list} FROM {table} WHERE stem = ? ORDER BY depSM'

        try:
            with sqlite3.connect(CACHE_DB) as conn:
                conn.row_factory = sqlite3.Row
                rows = conn.execute(query, (stem,)).fetchall()
        except sqlite3.OperationalError:
            rows = []

        if rows:
            print(f"FOUND PROFILE: stem={stem} table={table} type={instrument_type}")
            out_col_set = set(out_cols)
            return [
                {
                    **{col: (row[col] if col in out_col_set else None) for col in ALL_OUTPUT_COLUMNS},
                    "instrument_type": instrument_type,
                }
                for row in rows
            ]

    # Only reach here if type was explicit and stem wasn't found in that table
    raise HTTPException(
        status_code=404,
        detail=f"No profile found for '{stem}' in instrument type '{type or 'any'}'"
    )

@app.post("/spatial-profile")
def get_spatial_profile(box: SpatialBox):

    selected_stations = _stations_in_box(box)

    if not selected_stations:
        return {
            "mode": "spatial",
            "station_count": 0,
            "row_count": 0,
            "data": [],
        }

    merged_rows = []

    counts = {
        "ctd": 0,
        "xbt": 0,
        "xctd": 0,
    }

    with sqlite3.connect(CACHE_DB) as conn:

        conn.row_factory = sqlite3.Row

        for station in selected_stations:

            instrument_type = station["type"]

            counts[instrument_type] += 1

            stem = (
                station["file_name"]
                .strip()
                .rsplit(".", 1)[0]
                .lower()
            )

            cfg = INSTRUMENT_CONFIG[instrument_type]

            table = cfg["table"]

            out_cols = cfg["output_columns"]

            col_list = ", ".join(
                f'"{c}"'
                for c in out_cols
            )

            query = (
                f"SELECT {col_list} "
                f"FROM {table} "
                f"WHERE stem = ? "
                f"ORDER BY depSM"
            )

            rows = conn.execute(
                query,
                (stem,)
            ).fetchall()

            out_col_set = set(out_cols)

            for row in rows:

                merged_rows.append(
                    {
                        **{
                            col: (
                                row[col]
                                if col in out_col_set
                                else None
                            )
                            for col in ALL_OUTPUT_COLUMNS
                        },

                        "instrument_type": instrument_type,
                        "station_file": station["file_name"],
                    }
                )

    return {
        "mode": "spatial",

        "station_count": len(selected_stations),

        "ctd_count": counts["ctd"],
        "xbt_count": counts["xbt"],
        "xctd_count": counts["xctd"],

        "row_count": len(merged_rows),

        "data": merged_rows,
    }

@app.get("/grid-csv/{grid_id}")
def download_grid_csv( grid_id: str, startYear: int | None = Query(None), endYear: int | None = Query(None),):

    if not _valid_grid_id(grid_id):
        raise HTTPException(status_code=400, detail=f"Invalid grid_id: '{grid_id}'")

    df = _build_grid_training_df(grid_id, startYear, endYear,)

    if df.empty:
        raise HTTPException(status_code=404, detail=f"No observations found in {grid_id}")

    return Response(
        content=_df_to_csv_bytes(df),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{grid_id}.csv"'},
    )


@app.get("/grid-csv-all")
def download_all_grid_csvs( startYear: int | None = Query(None),endYear: int | None = Query(None),):

    buf = io.BytesIO()
    any_data = False

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for n in range(1, GRID_CELL_COUNT + 1):
            grid_id = f"Grid_{n}"
            df = _build_grid_training_df( grid_id, startYear, endYear,)
            if df.empty:
                continue
            any_data = True
            zf.writestr(f"{grid_id}.csv", _df_to_csv_bytes(df))

    if not any_data:
        raise HTTPException(status_code=404, detail="No observations found in any grid")

    buf.seek(0)
    return Response(
        content=buf.read(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="oceangrid_training_data.zip"'},
    )