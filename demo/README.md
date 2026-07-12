# Pi-Science Demo: Climate Trends Analysis

This demo walks through analyzing global temperature anomaly data using Pi-Science.

## Quick Start

```bash
# 1. Start Pi-Science
cd .. && bash scripts/dev.sh

# 2. Open http://localhost:5173

# 3. Use the demo data in this directory as your workspace
```

## Sample Prompts

Try these prompts in the chat interface:

### Basic Data Analysis
```
Analyze the monthly_global_anomalies.csv file in this workspace.
Calculate the trend and identify any periods of rapid change.
```

### Scientific Visualization
```
Plot the temperature anomaly data as a time series with a trend line.
Use matplotlib to create a publication-quality figure saved as anomaly_trend.png.
```

### Python Notebook
Open the Notebook panel and run these cells:

**Cell 1 (Python):**
```python
import pandas as pd
import matplotlib.pyplot as plt

df = pd.read_csv('demo/monthly_global_anomalies.csv')
print(df.head())
print(f"\nShape: {df.shape}")
print(f"Date range: {df['Year'].min()} - {df['Year'].max()}")
```

**Cell 2 (Python):**
```python
plt.figure(figsize=(12, 6))
plt.plot(df['Year'] + df['Month']/12, df['Anomaly_C'], linewidth=0.5, alpha=0.7)
plt.xlabel('Year')
plt.ylabel('Temperature Anomaly (°C)')
plt.title('Global Surface Temperature Anomalies')
plt.grid(True, alpha=0.3)
plt.savefig('anomaly_trend.png', dpi=150, bbox_inches='tight')
plt.show()
```

### File Inspection
- Click on `monthly_global_anomalies.csv` in the sidebar file browser
- The inspector panel will show a data table preview
- Switch to chart mode to see the data plotted as a line chart

## What This Demonstrates

1. **Agent Chat** — natural language data analysis
2. **File Preview** — CSV table and chart rendering
3. **Python Notebook** — interactive code execution with persistent namespace
4. **Artifact Inspection** — click on generated files to preview them
5. **Provenance** — every file written by the agent is tracked

## About the Data

The `monthly_global_anomalies.csv` file contains NASA GISTEMP v4 global-mean monthly
surface temperature anomalies (relative to 1951-1980 baseline), from 1880 through 2024.
Each row is one month with columns: Year, Month, Anomaly_C.
