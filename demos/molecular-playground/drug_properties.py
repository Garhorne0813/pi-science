#!/usr/bin/env python3
"""Calculate drug-likeness using Lipinski's Rule of 5."""

from __future__ import annotations

DRUGS = {
    "Aspirin": {"mw": 180.16, "logp": 1.19, "hbd": 1, "hba": 4},
    "Caffeine": {"mw": 194.19, "logp": -0.07, "hbd": 0, "hba": 3},
    "Paracetamol": {"mw": 151.16, "logp": 0.46, "hbd": 2, "hba": 2},
    "Ibuprofen": {"mw": 206.28, "logp": 3.97, "hbd": 1, "hba": 2},
    "Testosterone": {"mw": 288.42, "logp": 3.32, "hbd": 1, "hba": 2},
    "Curcumin": {"mw": 368.38, "logp": 3.29, "hbd": 2, "hba": 6},
}


def violations(data):
    checks = {
        "MW": (data["mw"], 500),
        "LogP": (data["logp"], 5),
        "HBD": (data["hbd"], 5),
        "HBA": (data["hba"], 10),
    }
    return [f"{name} {value} > {limit}" for name, (value, limit) in checks.items() if value > limit]


def main():
    print("💊 Drug-likeness: Lipinski's Rule of 5")
    print("=" * 55)
    print(f"{'Drug':<18} {'MW':>8} {'LogP':>6} {'HBD':>4} {'HBA':>4} {'Pass':>6}")
    print("-" * 55)

    for name, data in DRUGS.items():
        failed = violations(data)
        status = "✓" if not failed else f"✗ ({len(failed)} viol)"
        print(f"{name:<18} {data['mw']:>8.1f} {data['logp']:>6.2f} {data['hbd']:>4} {data['hba']:>4} {status:>6}")
        for failure in failed:
            print(f"    ⚠ {failure}")

    print()
    print("💡 Rule of 5: MW≤500, LogP≤5, HBD≤5, HBA≤10")

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        names = list(DRUGS)
        mw = [data["mw"] for data in DRUGS.values()]
        logp = [data["logp"] for data in DRUGS.values()]
        colors = ["#2E5090", "#C27828", "#358560", "#BE4D44", "#6B4E9B", "#C2577A"]

        fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 5))
        ax1.barh(names, mw, color=colors, alpha=0.8)
        ax1.axvline(500, color="red", linestyle="--", alpha=0.5, label="MW limit (500)")
        ax1.set_xlabel("Molecular Weight (Da)")
        ax1.set_title("Molecular Weight")
        ax1.legend(fontsize=8)

        ax2.scatter(logp, mw, c=colors, s=200, alpha=0.8, edgecolors="white", linewidth=1)
        for index, name in enumerate(names):
            ax2.annotate(name, (logp[index], mw[index]), fontsize=7)
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


if __name__ == "__main__":
    main()
