#!/usr/bin/env python3
"""Calculate drug-likeness using Lipinski's Rule of 5."""

DRUGS = {
    "Aspirin": {
        "mw": 180.16, "logp": 1.19, "hbd": 1, "hba": 4,
        "description": "NSAID — COX-1/COX-2 inhibitor. First synthetic drug.",
        "year": 1897,
    },
    "Caffeine": {
        "mw": 194.19, "logp": -0.07, "hbd": 0, "hba": 3,
        "description": "CNS stimulant — adenosine antagonist. Most consumed psychoactive.",
        "year": 1819,
    },
    "Paracetamol": {
        "mw": 151.16, "logp": 0.46, "hbd": 2, "hba": 2,
        "description": "Analgesic/antipyretic — weak COX inhibitor. WHO essential medicine.",
        "year": 1877,
    },
    "Ibuprofen": {
        "mw": 206.28, "logp": 3.97, "hbd": 1, "hba": 2,
        "description": "NSAID — non-selective COX inhibitor. Most used OTC painkiller.",
        "year": 1961,
    },
    "Testosterone": {
        "mw": 288.42, "logp": 3.32, "hbd": 1, "hba": 2,
        "description": "Androgen steroid hormone — AR agonist. Primary male sex hormone.",
        "year": 1935,
    },
    "Curcumin": {
        "mw": 368.38, "logp": 3.29, "hbd": 2, "hba": 6,
        "description": "Turmeric polyphenol — NF-kB inhibitor. Vibrant yellow color.",
        "year": 1815,
    },
}

def check_lipinski(name, data):
    """Lipinski's Rule of 5: oral drug-likeness."""
    violations = []
    if data["mw"] > 500: violations.append(f"MW {data['mw']} > 500")
    if data["logp"] > 5: violations.append(f"LogP {data['logp']} > 5")
    if data["hbd"] > 5: violations.append(f"HBD {data['hbd']} > 5")
    if data["hba"] > 10: violations.append(f"HBA {data['hba']} > 10")
    return violations

print("💊 Drug-likeness: Lipinski's Rule of 5")
print("=" * 55)
print(f"{'Drug':<18} {'MW':>8} {'LogP':>6} {'HBD':>4} {'HBA':>4} {'Pass':>6}")
print("-" * 55)

for name, data in DRUGS.items():
    v = check_lipinski(name, data)
    status = "✓" if len(v) == 0 else f"✗ ({len(v)} viol)"
    print(f"{name:<18} {data['mw']:>8.1f} {data['logp']:>6.2f} {data['hbd']:>4} {data['hba']:>4} {status:>6}")
    if v:
        for viol in v:
            print(f"    ⚠ {viol}")

print()
print("💡 Rule of 5: MW≤500, LogP≤5, HBD≤5, HBA≤10")
print("   Passing 0-1 rules = likely oral bioavailability")

# Plot
try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 5))

    names = list(DRUGS.keys())
    mw = [d["mw"] for d in DRUGS.values()]
    logp = [d["logp"] for d in DRUGS.values()]
    colors = ["#2E5090", "#C27828", "#358560", "#BE4D44", "#6B4E9B", "#C2577A"]

    ax1.barh(names, mw, color=colors, alpha=0.8)
    ax1.axvline(500, color="red", linestyle="--", alpha=0.5, label="MW limit (500)")
    ax1.set_xlabel("Molecular Weight (Da)")
    ax1.set_title("Molecular Weight")
    ax1.legend(fontsize=8)

    ax2.scatter(logp, mw, c=colors, s=200, alpha=0.8, edgecolors="white", linewidth=1)
    for i, name in enumerate(names):
        ax2.annotate(name, (logp[i], mw[i]), fontsize=7, ha="left" if i % 2 == 0 else "right")
    ax2.axhline(500, color="red", linestyle="--", alpha=0.3)
    ax2.axvline(5, color="red", linestyle="--", alpha=0.3)
    ax2.set_xlabel("LogP (lipophilicity)")
    ax2.set_ylabel("Molecular Weight (Da)")
    ax2.set_title("Drug Space (MW vs LogP)")

    plt.tight_layout()
    plt.savefig("drug_properties.png", dpi=150, bbox_inches="tight")
    print("\n📊 Plot saved: drug_properties.png")
except ImportError:
    print("\n⚠ matplotlib not available — skipping plot")
