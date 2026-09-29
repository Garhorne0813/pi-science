# Controlled file downloads

Pi agents can use `download_url(url, destination, expected_sha256?, max_bytes?)` to save a public HTTPS file in the current workspace. The tool asks the user to grant access to each hostname for the current session. A redirect to another hostname requires a separate grant. It then streams the file with a 256 MiB maximum, checks an optional SHA-256, publishes an artifact, and records a download receipt in workspace state.

For a UniProt protein accession, use `download_protein_structure(accession, destination?, source?)`. The control plane first verifies the UniProt record and returns its protein name, organism, and sequence length. With the default `best_available` source, it then searches RCSB for an exact accession-linked experimental entry and saves one mmCIF. If none is available, it uses the matching AlphaFold model. `source` can be `experimental` or `predicted` when the user requests one specifically. The downloaded mmCIF header is checked before publication; the result reports the protein identity, structure ID, path, size, SHA-256, and artifact ID. The read-only structures MCP tools remain available for structure search and comparison.

The research and conversation sandboxes remain offline. `download_url` runs in the Node control plane. It accepts HTTPS on port 443, rejects URL credentials and IP literals, and validates DNS again when making a direct connection. It rejects private and special-use addresses, including Clash fake IPs in `198.18.0.0/15`.

On macOS, the broker uses an enabled local system HTTPS proxy when present. On other platforms, or to override macOS discovery, set `PI_SCIENCE_EGRESS_PROXY_URL=http://127.0.0.1:<port>` before starting the server. Only an explicitly configured local HTTP(S) proxy is accepted. The proxy resolves the approved hostname; fake-IP addresses are never treated as public IPs by the application.

For example, after granting `files.rcsb.org`, an agent can download `https://files.rcsb.org/download/2V40.cif` to `structures/2V40.cif` and open the resulting mmCIF in the file preview.
