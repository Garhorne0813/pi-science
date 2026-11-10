# Report measurable progress to Pi-Science from R.
#
# Nothing sources this file automatically, so an R script that does not call it
# behaves exactly as before. A percentage printed by cli, progress or utils is
# not read: the helpers below report the real counter instead.
#
#   source("pi_progress.R")
#   step <- pi_progress_bar(10, "Processing items")
#   for (item in 1:10) step()

pi_progress_report <- function(current = NULL, total = NULL, scope = "r",
                               label = "Progress", unit = NULL, total_kind = NULL) {
  payload <- list(version = 1, scopeId = scope, scopeLabel = label)
  if (!is.null(current)) payload$current <- current
  if (!is.null(total)) payload$total <- total
  payload$totalKind <- if (!is.null(total_kind)) total_kind else if (is.null(total)) "unknown" else "fixed"
  if (!is.null(unit)) payload$unit <- unit
  # One complete line per record: a partial line is read as ordinary output.
  cat("<<pi-progress>> ", pi_progress_json(payload), "\n", sep = "", file = stderr())
  flush(stderr())
  invisible(NULL)
}

# The record is a flat object, so it is written without a JSON dependency.
pi_progress_json <- function(values) {
  parts <- vapply(names(values), function(key) {
    value <- values[[key]]
    # encodeString quotes the value and escapes the two characters JSON cares about.
    text <- if (is.numeric(value)) format(value, scientific = FALSE, trim = TRUE) else encodeString(as.character(value), quote = '"')
    paste0('"', key, '":', text)
  }, character(1))
  paste0("{", paste(parts, collapse = ","), "}")
}

# Returns a function that reports the step it reaches each time it is called.
pi_progress_bar <- function(total, label = "Progress", scope = "r", unit = "items") {
  reached <- 0L
  function(step = 1L) {
    reached <<- reached + step
    pi_progress_report(reached, total, scope = scope, label = label, unit = unit)
    invisible(reached)
  }
}
