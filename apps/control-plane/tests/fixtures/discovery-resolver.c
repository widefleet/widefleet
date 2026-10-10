// Test-only native resolver boundary. Loaded into CLI subprocesses, never into
// the test runner. Synthetic answers avoid changing or querying the host's DNS.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int res_query(const char *name, int record_class, int record_type,
              unsigned char *answer, int capacity) {
    const char *log_path = getenv("WIDEFLEET_TEST_DNS_LOG");
    if (log_path) {
        FILE *log = fopen(log_path, "a");
        if (log) {
            fprintf(log, "%s %d %d\n", name, record_class, record_type);
            fclose(log);
        }
    }
    if (getenv("WIDEFLEET_TEST_DNS_DELAY")) sleep(30);
    if (strcmp(name, "_widefleet.example.test.") || record_class != 1 || record_type != 16)
        return -1;

    const char *path = getenv("WIDEFLEET_TEST_DNS_RESPONSE");
    if (!path || capacity <= 0) return -1;
    FILE *input = fopen(path, "rb");
    if (!input) return -1;
    size_t length = fread(answer, 1, (size_t)capacity, input);
    fclose(input);
    return (int)length;
}
