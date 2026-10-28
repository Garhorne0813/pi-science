// Node-API bridge for directory operations absent from node:fs. Paths are
// opened by the caller with O_NOFOLLOW_ANY; all lookups stay relative to that fd.
#include <node_api.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static napi_value failure(napi_env env, const char *code) {
  napi_throw_error(env, code, code);
  return NULL;
}

static int directory_fd(napi_env env, napi_value value, int *fd) {
  double number;
  struct stat info;
  if (napi_get_value_double(env, value, &number) != napi_ok ||
      !isfinite(number) || number < 0 || number > 2147483647 || (double)(int)number != number) return 0;
  *fd = (int)number;
  if (fstat(*fd, &info) != 0 || !S_ISDIR(info.st_mode)) {
    return 0;
  }
  return 1;
}

static napi_value names(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2], result, name;
  int fd;
  double maximum;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 2 ||
      !directory_fd(env, args[0], &fd)) return failure(env, "EINVAL");
  if (napi_get_value_double(env, args[1], &maximum) != napi_ok ||
      !isfinite(maximum) || maximum < 1 || maximum > 20001 || (double)(int)maximum != maximum) return failure(env, "EINVAL");
  int copy = fcntl(fd, F_DUPFD_CLOEXEC, 0);
  if (copy < 0) return failure(env, "EACCES");
  DIR *directory = fdopendir(copy);
  if (!directory) { close(copy); return failure(env, "EACCES"); }
  if (napi_create_array(env, &result) != napi_ok) { closedir(directory); return NULL; }
  uint32_t index = 0;
  int error = 0;
  while (index < (uint32_t)maximum) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (!entry) { error = errno; break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &name) != napi_ok ||
        napi_set_element(env, result, index++, name) != napi_ok) {
      closedir(directory); return NULL;
    }
  }
  if (closedir(directory) != 0 || error) return failure(env, "EACCES");
  return result;
}

static napi_value entry_stat(napi_env env, napi_callback_info info) {
  size_t argc = 2, length;
  napi_value args[2], result, value;
  int fd;
  char name[1025];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 2 ||
      !directory_fd(env, args[0], &fd)) return failure(env, "EINVAL");
  if (napi_get_value_string_utf8(env, args[1], NULL, 0, &length) != napi_ok ||
      length == 0 || length >= sizeof(name)) return failure(env, "EINVAL");
  if (napi_get_value_string_utf8(env, args[1], name, sizeof(name), &length) != napi_ok ||
      strlen(name) != length || strchr(name, '/') || !strcmp(name, ".") || !strcmp(name, "..")) return failure(env, "EINVAL");
  struct stat stat;
  if (fstatat(fd, name, &stat, AT_SYMLINK_NOFOLLOW) != 0) return failure(env, errno == ENOENT ? "ENOENT" : "EACCES");
  if (napi_create_object(env, &result) != napi_ok) return NULL;
  napi_get_boolean(env, S_ISDIR(stat.st_mode), &value);
  napi_set_named_property(env, result, "directory", value);
  napi_get_boolean(env, S_ISREG(stat.st_mode), &value);
  napi_set_named_property(env, result, "file", value);
  napi_create_double(env, (double)stat.st_nlink, &value);
  napi_set_named_property(env, result, "nlink", value);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"names", NULL, names, NULL, NULL, NULL, napi_default, NULL},
    {"stat", NULL, entry_stat, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports, 2, methods) != napi_ok) return NULL;
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
