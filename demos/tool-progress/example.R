source("pi_progress.R")

step <- pi_progress_bar(10, "Processing items")
for (item in 1:10) {
  Sys.sleep(0.2)
  step()
}

pi_progress_report(4, label = "Rechecking", unit = "files")
