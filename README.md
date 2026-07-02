# OceanGrid

## Requirements

Before getting started, make sure you have the following installed:

- Python 3.10 or newer
- Node.js (recommended: **v22 LTS**)
- npm
- Git

You can check your versions with:

```bash
python --version
node -v
npm -v
```

---

## Configure the Data

Before running the project, update the data paths in the backend.

Open:

```
backend/main.py
```

Update the following paths:

- **Metadata CSV** – path to your metadata file.
- **Data Directory** – folder containing the CTD/XBT/XCTD profile files.

Example:

```python
METADATA_PATH = "/path/to/metadata.csv"
DATA_ROOT = "/path/to/profile_data/"
```

---

## Running the Backend

```bash
cd backend

python -m venv venv
source venv/bin/activate      # Linux/macOS
# venv\Scripts\activate       # Windows

pip install -r requirements.txt

uvicorn main:app --reload
```

The backend will start on:

```
http://localhost:8000
```

---

## Running the Frontend

```bash
cd frontend

npm install

npm run dev
```

The frontend will be available at:

```
http://localhost:5173
```

---

## Notes

- Make sure the backend is running before starting the frontend.
- If you change the backend port, update the frontend API URL accordingly.
- If no data appears on the map, double-check that the metadata path and data directory are configured correctly.# ocean-grid
