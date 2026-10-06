// LD_PRELOAD shim for sandboxes without IPv6: IPv6 UDP sockets requested by the
// Bedrock Dedicated Server are transparently created as IPv4 sockets bound to the
// v6 port on 0.0.0.0. Only used by the local test harness.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <netinet/in.h>
#include <string.h>
#include <sys/socket.h>

static int (*real_socket)(int, int, int);
static int (*real_bind)(int, const struct sockaddr *, socklen_t);
static int (*real_setsockopt)(int, int, int, const void *, socklen_t);
static int v6fds[4096];

int socket(int domain, int type, int protocol) {
  if (!real_socket) real_socket = dlsym(RTLD_NEXT, "socket");
  if (domain == AF_INET6) {
    int fd = real_socket(AF_INET, type, protocol);
    if (fd >= 0 && fd < 4096) v6fds[fd] = 1;
    return fd;
  }
  int fd = real_socket(domain, type, protocol);
  if (fd >= 0 && fd < 4096) v6fds[fd] = 0;
  return fd;
}

int bind(int fd, const struct sockaddr *addr, socklen_t len) {
  if (!real_bind) real_bind = dlsym(RTLD_NEXT, "bind");
  if (addr && addr->sa_family == AF_INET6) {
    const struct sockaddr_in6 *a6 = (const struct sockaddr_in6 *)addr;
    struct sockaddr_in a4;
    memset(&a4, 0, sizeof a4);
    a4.sin_family = AF_INET;
    a4.sin_port = a6->sin6_port;
    a4.sin_addr.s_addr = htonl(INADDR_ANY);
    return real_bind(fd, (struct sockaddr *)&a4, sizeof a4);
  }
  return real_bind(fd, addr, len);
}

int setsockopt(int fd, int level, int name, const void *val, socklen_t len) {
  if (!real_setsockopt) real_setsockopt = dlsym(RTLD_NEXT, "setsockopt");
  if (level == IPPROTO_IPV6 && fd >= 0 && fd < 4096 && v6fds[fd]) return 0;
  return real_setsockopt(fd, level, name, val, len);
}
