#!/usr/bin/env python3
"""Lipinski's Rule of 5 — drug-likeness calculator."""

DRUGS = {
    "Aspirin (C9H8O4)": {"mw":180.16,"logp":1.19,"hbd":1,"hba":4,
        "desc":"NSAID, COX-1/COX-2 inhibitor. First synthetic drug (1897)."},
    "Caffeine (C8H10N4O2)": {"mw":194.19,"logp":-0.07,"hbd":0,"hba":3,
        "desc":"CNS stimulant, adenosine antagonist. Most consumed psychoactive."},
    "Paracetamol": {"mw":151.16,"logp":0.46,"hbd":2,"hba":2,
        "desc":"Analgesic/antipyretic. WHO essential medicine."},
    "Ibuprofen": {"mw":206.28,"logp":3.97,"hbd":1,"hba":2,
        "desc":"NSAID, non-selective COX inhibitor. Most used OTC painkiller."},
    "Curcumin": {"mw":368.38,"logp":3.29,"hbd":2,"hba":6,
        "desc":"Turmeric polyphenol, NF-kB inhibitor. Natural yellow pigment."},
    "Testosterone": {"mw":288.42,"logp":3.32,"hbd":1,"hba":2,
        "desc":"Androgen steroid hormone. Primary male sex hormone."},
}

print("Drug-likeness: Lipinski Rule of 5")
print("="*55)
print(f"{'Drug':<24} {'MW':>8} {'LogP':>6} {'HBD':>4} {'HBA':>4} {'Status':>10}")
print("-"*55)
for name, d in DRUGS.items():
    v = 0
    if d["mw"]>500: v+=1
    if d["logp"]>5: v+=1
    if d["hbd"]>5: v+=1
    if d["hba"]>10: v+=1
    status = "PASS" if v<=1 else f"FAIL({v})"
    print(f"{name:<24} {d['mw']:>8.1f} {d['logp']:>6.2f} {d['hbd']:>4} {d['hba']:>4} {status:>10}")
print()
print("Rule: MW<=500, LogP<=5, HBD<=5, HBA<=10")
print("Passing all 4 rules = good oral bioavailability")

try:
    import matplotlib; matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    names=[n[:12] for n in DRUGS]
    mw=[d["mw"] for d in DRUGS.values()]
    logp=[d["logp"] for d in DRUGS.values()]
    plt.figure(figsize=(8,6))
    plt.scatter(logp,mw,s=[d["mw"]/2 for d in DRUGS.values()],alpha=0.7,c=range(6),cmap="viridis",edgecolors="white",linewidth=1)
    for i,n in enumerate(names): plt.annotate(n,(logp[i],mw[i]),fontsize=8)
    plt.axhline(500,color="red",ls="--",alpha=0.3)
    plt.axvline(5,color="red",ls="--",alpha=0.3)
    plt.xlabel("LogP (lipophilicity)"); plt.ylabel("Molecular Weight (Da)")
    plt.title("Chemical Space: MW vs LogP"); plt.tight_layout()
    plt.savefig("drug_properties.png",dpi=150,bbox_inches="tight")
    print("Plot saved: drug_properties.png")
except ImportError:
    print("(matplotlib not available — skipping plot)")
