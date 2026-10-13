#!/usr/bin/env Rscript
# Minimal local R kernel for the Open Science notebook.
#
# A persistent process that holds one environment across cells (shared state,
# like a Jupyter kernel). The host writes the cell's code to a file (argv[1]),
# then sends one line "<id>" on stdin; we evaluate that file in the global
# environment and write ONE JSON response line back to stdout:
#
#     response: {"id","ok","stdout","stderr","result","error","truncated"}\n
#
# Base R only — no jsonlite/IRkernel — so it runs against any R install,
# offline, with no model key. `result` mirrors Jupyter: the printed value of the
# cell's final expression when it is visible, else null. The host appends its
# output caps after the code file as `--limits <json>`; captured text is bounded
# at emit time, and `truncated` counts characters produced but not delivered.

args <- commandArgs(trailingOnly = TRUE)
codefile <- args[1]
options(warn = 1) # surface warnings inline (stderr), not deferred to session end

KERNEL_TRUNCATION_MARKER <- "\n… [truncated]"

# The limits arrive as flat JSON. Reading the five known integer fields by hand
# keeps the bridge on base R, which ships no JSON parser.
limits_from_args <- function(args) {
  limits <- list(stdout_chars = 65536, stderr_chars = 65536, result_chars = 262144, mime_chars = 1048576, outputs_chars = 2097152)
  index <- match("--limits", args)
  if (is.na(index) || index >= length(args)) return(limits)
  raw <- args[[index + 1]]
  for (name in names(limits)) {
    hit <- regmatches(raw, regexpr(paste0("\"", name, "\"[[:space:]]*:[[:space:]]*[0-9]+"), raw))
    if (length(hit) != 1) next
    value <- suppressWarnings(as.numeric(sub("^.*:", "", hit)))
    if (!is.na(value) && value > 0) limits[[name]] <- value
  }
  limits
}

# Head + marker + tail at most cap characters, with the characters dropped.
bound_text <- function(value, cap) {
  marker <- KERNEL_TRUNCATION_MARKER
  produced <- nchar(value, type = "chars")
  if (produced <= cap) return(list(text = value, dropped = 0))
  marker <- substr(marker, 1, cap) # a cap inside the marker keeps only the marker
  head_cap <- max(floor((cap - nchar(marker, type = "chars")) / 2), 0)
  tail_cap <- max(cap - nchar(marker, type = "chars") - head_cap, 0)
  kept <- paste0(substr(value, 1, head_cap), marker, if (tail_cap > 0) substr(value, produced - tail_cap + 1, produced) else "")
  list(text = kept, dropped = produced - nchar(kept, type = "chars"))
}

# Head + marker at most cap characters; the printed tail expression keeps no tail.
bound_head <- function(value, cap) {
  marker <- KERNEL_TRUNCATION_MARKER
  produced <- nchar(value, type = "chars")
  if (produced <= cap) return(list(text = value, dropped = 0))
  marker <- substr(marker, 1, cap)
  kept <- paste0(substr(value, 1, max(cap - nchar(marker, type = "chars"), 0)), marker)
  list(text = kept, dropped = produced - nchar(kept, type = "chars"))
}

# Accumulate a dropped-character count under one report key.
charge <- function(truncated, key, dropped) {
  if (dropped > 0) truncated[[key]] <- if (is.null(truncated[[key]])) dropped else truncated[[key]] + dropped
  truncated
}

# JSON-escape a scalar string. fixed = TRUE keeps replacements literal so we do
# not fight regex metacharacters; control chars left after \n\r\t are dropped.
json_escape <- function(s) {
  if (length(s) != 1) s <- paste(s, collapse = "\n")
  if (is.na(s)) return("")
  s <- gsub("\\", "\\\\", s, fixed = TRUE)
  s <- gsub("\"", "\\\"", s, fixed = TRUE)
  s <- gsub("\n", "\\n", s, fixed = TRUE)
  s <- gsub("\r", "\\r", s, fixed = TRUE)
  s <- gsub("\t", "\\t", s, fixed = TRUE)
  s <- gsub("[[:cntrl:]]", "", s)
  s
}

emit <- function(id, ok, out, stderr, result, error, truncated) {
  parts <- c(
    paste0("\"id\":\"", json_escape(id), "\""),
    paste0("\"ok\":", if (ok) "true" else "false"),
    paste0("\"stdout\":\"", json_escape(out), "\""),
    paste0("\"stderr\":\"", json_escape(stderr), "\""),
    if (is.null(result)) "\"result\":null" else paste0("\"result\":\"", json_escape(result), "\""),
    if (is.null(error)) "\"error\":null" else paste0("\"error\":\"", json_escape(error), "\""),
    if (length(truncated) == 0) NULL else paste0("\"truncated\":{", paste(sprintf("\"%s\":%.0f", names(truncated), unlist(truncated, use.names = FALSE)), collapse = ","), "}")
  )
  cat(paste0("{", paste(parts, collapse = ","), "}"), "\n", sep = "")
  flush(stdout())
}

run_cell <- function(code, limits) {
  truncated <- list()
  exprs <- tryCatch(parse(text = code), error = function(e) e)
  if (inherits(exprs, "error")) {
    # The host's frame guard counts this field, so an unbounded parse message
    # would kill the kernel instead of reporting the cell error.
    parse_error <- bound_text(paste0("Error: ", conditionMessage(exprs)), limits$stderr_chars)
    return(list(ok = FALSE, stdout = "", stderr = "", result = NULL,
                error = parse_error$text,
                truncated = charge(truncated, "stderr_chars", parse_error$dropped)))
  }
  captured <- character(0)
  captured_stderr <- character(0)
  buf <- textConnection("captured", open = "w", local = TRUE)
  err_buf <- textConnection("captured_stderr", open = "w", local = TRUE)
  sink(buf)
  sink(err_buf, type = "message")
  result <- NULL
  err <- NULL
  tryCatch({
    n <- length(exprs)
    if (n > 0) for (i in seq_len(n)) {
      wv <- withVisible(eval(exprs[[i]], envir = globalenv()))
      if (wv$visible) {
        printed <- paste(utils::capture.output(print(wv$value)), collapse = "\n")
        if (i == n) result <- printed else cat(printed, "\n", sep = "")
      }
    }
  }, error = function(e) {
    err <<- paste0("Error: ", conditionMessage(e))
  })
  sink(type = "message")
  sink()
  close(err_buf)
  close(buf)
  out <- bound_text(paste(captured, collapse = "\n"), limits$stdout_chars)
  err_out <- bound_text(paste(captured_stderr, collapse = "\n"), limits$stderr_chars)
  bounded_result <- if (is.null(result)) NULL else bound_head(result, limits$result_chars)
  bounded_err <- if (is.null(err)) NULL else bound_text(err, limits$stderr_chars)
  truncated <- charge(truncated, "stdout_chars", out$dropped)
  truncated <- charge(truncated, "stderr_chars", err_out$dropped)
  # A traceback shares the stderr channel and its cap.
  truncated <- charge(truncated, "stderr_chars", if (is.null(bounded_err)) 0 else bounded_err$dropped)
  truncated <- charge(truncated, "result_chars", if (is.null(bounded_result)) 0 else bounded_result$dropped)
  list(ok = is.null(err), stdout = out$text, stderr = err_out$text,
       result = if (is.null(bounded_result)) NULL else bounded_result$text,
       error = if (is.null(bounded_err)) NULL else bounded_err$text, truncated = truncated)
}

limits <- limits_from_args(args)
con <- file("stdin", open = "r")
repeat {
  line <- readLines(con, n = 1)
  if (length(line) == 0) break # host closed stdin -> exit
  id <- trimws(line)
  if (nchar(id) == 0) next
  code <- tryCatch(paste(readLines(codefile, warn = FALSE), collapse = "\n"),
                   error = function(e) "")
  r <- run_cell(code, limits)
  emit(id, r$ok, r$stdout, r$stderr, r$result, r$error, r$truncated)
}
