for (const key of Object.keys(process.env)) {
  if (key.startsWith("GNHF_SLEEP_") || key.startsWith("GNHF_REEXEC_")) {
    delete process.env[key];
  }
}
