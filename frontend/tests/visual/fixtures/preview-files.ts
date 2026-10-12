import { readFileSync } from "node:fs";

const mesh = `solid tetrahedron
facet normal 0 0 -1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 0
endloop
endfacet
facet normal 0 -1 0
outer loop
vertex 0 0 0
vertex 0 0 1
vertex 1 0 0
endloop
endfacet
facet normal -1 0 0
outer loop
vertex 0 0 0
vertex 0 1 0
vertex 0 0 1
endloop
endfacet
facet normal 1 1 1
outer loop
vertex 1 0 0
vertex 0 0 1
vertex 0 1 0
endloop
endfacet
endsolid tetrahedron`;
function fitsImage() {
  const card = (key: string, value?: string) => (key.padEnd(8) + (value === undefined ? "" : `= ${value.padStart(20)}`)).padEnd(80);
  const header = [card("SIMPLE", "T"), card("BITPIX", "16"), card("NAXIS", "2"), card("NAXIS1", "32"), card("NAXIS2", "32"), card("BUNIT", "'adu'"), card("END")].join("").padEnd(2880);
  const buffer = Buffer.alloc(2880 + 2880);
  buffer.write(header, "ascii");
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) buffer.writeInt16BE(Math.round(1000 * Math.exp(-((x - 16) ** 2 + (y - 16) ** 2) / 70)), 2880 + 2 * (y * 32 + x));
  return buffer;
}
export const previewFiles: Record<string, { data: string | Buffer; mime?: string }> = {
  "sample.py": { data: "# Fit the measurements\nimport numpy as np\n\nx = np.arange(10)\nprint(np.mean(x))\n" },
  "sample.csv": { data: "sample,value,error\nA,1.25,0.01\nB,-2.5e-3,0.02\nC,12,0.03\n" },
  "sample.svg": { data: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#e9eef8"/><circle cx="300" cy="200" r="120" fill="#427ce0"/><path d="M100 320L500 80" stroke="#fff" stroke-width="12"/></svg>', mime: "image/svg+xml" },
  "sample.bed": { data: "chr1\t0\t100\tgene_A\t900\t+\nchr1\t120\t280\tgene_B\t400\t-\nchr2\t0\t80\tgene_C\t500\t+\n" },
  "sample.stl": { data: Buffer.from(mesh) },
  "sample.fits": { data: fitsImage() },
  "sample.pdb": { data: readFileSync(new URL("../../../../demos/molecular-playground/data/1LYS.pdb", import.meta.url), "utf8") },
};
