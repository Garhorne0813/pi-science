/* A private Mach permission identifies one sandbox and its descendants even
 * after setsid/reparenting. Host processes allow both probes and are excluded.
 * The supervisor lives outside the workload's process group and watches its
 * JS owner independently. The tag names no real Mach service. */
#include <sys/types.h>
#include <sys/wait.h>
#include <libproc.h>
#include <sandbox.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* Darwin sandbox SPI, also declared by compiler-rt's sanitizer_mac_spi.cpp.
 * The SDK exposes sandbox_init but omits the query API. Linking or querying
 * failure refuses execution rather than dropping descendant supervision. */
extern int sandbox_check(pid_t, const char *, int, ...);
extern const int SANDBOX_CHECK_NO_REPORT;
enum { SANDBOX_FILTER_GLOBAL_NAME = 2 };

#define MAX_PROCESSES 65536
typedef struct { pid_t pid; uint64_t seconds; uint64_t micros; } tracked_process;
static tracked_process tracked[MAX_PROCESSES];
static size_t count;
static volatile sig_atomic_t stopping;
static void stop(int sig) { (void)sig; stopping = 1; }
static void add(pid_t pid) {
  struct proc_bsdinfo info;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return;
  for (size_t i = 0; i < count; ++i) if (tracked[i].pid == pid && tracked[i].seconds == info.pbi_start_tvsec && tracked[i].micros == info.pbi_start_tvusec) return;
  if (count == MAX_PROCESSES) { stopping = 1; return; }
  tracked[count++] = (tracked_process){ pid, info.pbi_start_tvsec, info.pbi_start_tvusec };
}
static int alive(tracked_process item) {
  struct proc_bsdinfo info;
  return proc_pidinfo(item.pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) == sizeof(info) && info.pbi_start_tvsec == item.seconds && info.pbi_start_tvusec == item.micros;
}
static int known(pid_t pid) {
  for (size_t i = 0; i < count; ++i) if (tracked[i].pid == pid && alive(tracked[i])) return 1;
  return 0;
}
static void discover(const char *tag, const char *deny_tag) {
  pid_t pids[MAX_PROCESSES];
  int n = proc_listallpids(pids, sizeof(pids));
  if (n <= 0 || n >= MAX_PROCESSES) { stopping = 1; return; }
  for (int i = 0; i < n; ++i) {
    pid_t pid = pids[i];
    if (pid <= 1 || pid == getpid()) continue;
    struct proc_bsdinfo info;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info) || info.pbi_uid != getuid()) continue;
    if (known((pid_t)info.pbi_ppid)) { add(pid); continue; }
    if (sandbox_check(pid, "mach-lookup", SANDBOX_FILTER_GLOBAL_NAME | SANDBOX_CHECK_NO_REPORT, tag) == 0 &&
        sandbox_check(pid, "mach-lookup", SANDBOX_FILTER_GLOBAL_NAME | SANDBOX_CHECK_NO_REPORT, deny_tag) > 0) add(pid);
  }
}
static void signal_all(int sig) {
  for (size_t i = 0; i < count; ++i) if (alive(tracked[i])) kill(tracked[i].pid, sig);
}
int main(int argc, char **argv) {
  if (argc < 6) return 125;
  pid_t owner = getppid();
  int lifetime = atoi(argv[1]);
  if (owner <= 1 || lifetime <= 0) return 125;
  signal(SIGTERM, stop); signal(SIGINT, stop); signal(SIGHUP, stop);
  pid_t root = fork();
  if (root < 0) return 125;
  if (root == 0) {
    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGHUP, SIG_DFL);
    execv(argv[4], &argv[4]);
    perror("sandbox supervisor exec"); _exit(127);
  }
  add(root);
  struct timespec started; clock_gettime(CLOCK_MONOTONIC, &started);
  int root_exited = 0, result = 125, empty_rounds = 0;
  for (;;) {
    struct timespec now; clock_gettime(CLOCK_MONOTONIC, &now);
    if (getppid() != owner || now.tv_sec - started.tv_sec >= lifetime) stopping = 1;
    discover(argv[2], argv[3]);
    if (stopping || root_exited) { signal_all(SIGSTOP); discover(argv[2], argv[3]); signal_all(SIGKILL); }
    int status;
    if (!root_exited && waitpid(root, &status, WNOHANG) == root) {
      root_exited = 1;
      result = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
    }
    size_t live = 0;
    for (size_t i = 0; i < count; ++i) if (alive(tracked[i])) tracked[live++] = tracked[i];
    count = live;
    if ((stopping || root_exited) && !count) { if (++empty_rounds >= 2) break; } else empty_rounds = 0;
    struct timespec delay = {0, 20000000}; nanosleep(&delay, NULL);
  }
  return stopping ? 125 : result;
}
