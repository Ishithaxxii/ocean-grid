import pandas as pd
import re


MISSING_VALUES = {"", "N/A", "NA", "NAN", "NONE", "NULL", "UNKNOWN"}
KNOWN_SHIPS = {"FORV SAGAR SAMPADA", "ORV SAGAR KANYA", "INSS"}


def _clean_text(value):
    if pd.isna(value):
        return ""
    return " ".join(str(value).strip().split())


def _is_missing(value):
    return _clean_text(value).upper() in MISSING_VALUES

def standardize_ship_name(ship):

    if pd.isna(ship):
        return "UNKNOWN"

    ship = str(ship).upper().strip()

    ship = " ".join(ship.split())

    if ship in MISSING_VALUES:
        return "UNKNOWN"

    # FORV SAGAR SAMPADA
    if (
        "SAGAR SAMPADA" in ship
        or "SAPMADA" in ship
        or "SANPADA" in ship
        or ship == "SS"
    ):
        return "FORV SAGAR SAMPADA"

    # ORV SAGAR KANYA
    if (
        "SAGAR KANYA" in ship
        or "SAGARKANYA" in ship
        or "ORV SK" in ship
        or ship == "SK"
    ):
        return "ORV SAGAR KANYA"
    
    if ("INSS" in ship):
        return "INSS"

    return ship


def infer_ship_from_metadata(row):
    """Resolve ship name from Ship, then source/path fields when Ship is absent."""

    ship = row.get("Ship", "")
    standardized_ship = "UNKNOWN"
    if not _is_missing(ship):
        standardized_ship = standardize_ship_name(ship)
        if standardized_ship in KNOWN_SHIPS:
            return standardized_ship

    source_fields = [
        row.get("SourceSubFolder", ""),
        row.get("SourceFolder", ""),
        row.get("SourceFile", ""),
        row.get("FileName", ""),
        row.get("Cruise", ""),
    ]
    source_text = " ".join(_clean_text(value) for value in source_fields).upper()

    if not source_text:
        return standardized_ship

    if "SAGAR SAMPADA" in source_text or "SAPMADA" in source_text or "SANPADA" in source_text:
        return "FORV SAGAR SAMPADA"

    if "SAGAR KANYA" in source_text or "SAGARKANYA" in source_text:
        return "ORV SAGAR KANYA"

    if "SAGARDHWANI" in source_text or re.search(r"\bINSS\b", source_text):
        return "INSS"

    # SK cruise/path markers appear in files such as SK251A and CTD_SK277.
    if re.search(r"(^|[^A-Z0-9])SK\s*\d+[A-Z]?\b", source_text) or re.search(r"\bSTN\d+[A-Z_]*SK\b", source_text):
        return "ORV SAGAR KANYA"

    # CMLRE CTD source subfolders use cr### cruise folders for Sagar Sampada.
    if re.search(r"(^|[^A-Z0-9])CR\s*\d{2,4}\b", source_text) or re.search(r"\bCRUISE\s*\d{2,4}\b", source_text):
        return "FORV SAGAR SAMPADA"

    return standardized_ship


# ==========================================
# MAIN PROCESSOR
# ==========================================

def process_metadata(df):

    # --------------------------------------
    # COLUMN NORMALIZATION
    # --------------------------------------

    COLUMN_MAP = {

        "Latitude_decimal": "Latitude",

        "Longitude_decimal": "Longitude",

        "Ship": "Ship",

        "Cruise": "Cruise",

        "Datetime": "Datetime",

        "Station Number": "Station",

        "Station Depth": "Depth",

        "FileName": "FileName"
    }

    df = df.rename(columns=COLUMN_MAP)

    # --------------------------------------
    # REQUIRED COLUMNS
    # --------------------------------------

    required_columns = [
        "Latitude",
        "Longitude"
    ]

    for col in required_columns:

        if col not in df.columns:
            raise Exception(f"Missing required column: {col}")

    # --------------------------------------
    # CLEAN COORDINATES
    # --------------------------------------

    df["Latitude"] = pd.to_numeric(
        df["Latitude"],
        errors="coerce"
    )

    df["Longitude"] = pd.to_numeric(
        df["Longitude"],
        errors="coerce"
    )

    # remove bad rows
    df = df.dropna(
        subset=["Latitude", "Longitude"]
    )

    # --------------------------------------
    # STANDARDIZE SHIP NAMES
    # --------------------------------------

    df["Ship"] = df.apply(
        infer_ship_from_metadata,
        axis=1
    )

    # --------------------------------------
    # FILL MISSING VALUES
    # --------------------------------------

    fill_cols = [
        "Cruise",
        "Station",
        "Datetime",
        "Depth",
        "FileName"
    ]

    for col in fill_cols:

        if col not in df.columns:
            df[col] = "N/A"

        df[col] = df[col].fillna("N/A")

    return df
