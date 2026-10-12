export function parseLine(text) {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
  const match = clean.match(/^([EWIDV]) \((\d+)\) ([^:]+):\s?(.*)$/);
  return { text: clean, level: match?.[1] ?? "", tag: match?.[3] ?? "", message: match?.[4] ?? clean };
}

export class LogBuffer {
  constructor(maxLines = 5000, maxLineLength = 16384) {
    this.maxLines = maxLines;
    this.maxLineLength = maxLineLength;
    this.clear();
  }
  clear() {
    this.lines = [];
    this.pending = "";
    this.overflow = false;
    this.evicted = 0;
    this.truncated = 0;
    this.total = 0;
  }
  append(text) {
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      const room = this.maxLineLength - this.pending.length;
      this.pending += parts[i].slice(0, room);
      this.overflow ||= parts[i].length > room;
      if (i < parts.length - 1) this.flush();
    }
  }
  flush() {
    if (this.pending || this.overflow) {
      const suffix = this.overflow ? " [line truncated]" : "";
      this.lines.push(parseLine(this.pending + suffix));
      this.total++;
      if (this.overflow) this.truncated++;
      if (this.lines.length > this.maxLines) {
        this.lines.shift();
        this.evicted++;
      }
    }
    this.pending = "";
    this.overflow = false;
  }
}

export function analyze(lines) {
  const crashes = lines.filter(line => /Guru Meditation|panic'ed|Backtrace:|assert failed|stack smashing|CORRUPT HEAP|Brownout detector|Task watchdog got triggered/i.test(line.text));
  const errors = lines.filter(line => line.level === "E");
  const warnings = lines.filter(line => line.level === "W");
  const memory = lines.filter(line => /free sram: \d+ minimal sram: \d+/i.test(line.text));
  const latestMemory = memory.at(-1)?.text.match(/free sram: (\d+) minimal sram: (\d+)/i);
  const states = lines.filter(line => line.tag === "Application" && /STATE:/.test(line.message));
  const result = (title, evidence, summary, status = "Observed") => ({
    title, status: evidence.length ? status : "Not observed",
    summary: evidence.length ? summary : "No matching messages in the retained capture.",
    evidence: evidence.slice(-3).map(line => line.text),
  });
  const report = [
    result("Crash / reset", crashes, `${crashes.length} crash, watchdog, or brownout indicators. Investigate the source log.`, "Investigate"),
    result("Errors / warnings", lines.filter(line => line.level === "E" || line.level === "W"), `${errors.length} error and ${warnings.length} warning messages. Severity alone does not prove hardware failure.`, errors.length ? "Investigate" : "Review"),
    result("Memory", memory, latestMemory ? `Latest free SRAM: ${latestMemory[1]} bytes. Minimum reported: ${latestMemory[2]} bytes. No health threshold assumed.` : ""),
    result("Application state", states, states.at(-1)?.message ?? ""),
  ];
  for (const [title, pattern] of [
    ["Camera", /camera|sccb|gc0308|esp_video/i],
    ["Audio", /audio|codec|i2s|wake.?word/i],
    ["Network", /wifi|wi-fi|mqtt|websocket|network|station/i],
  ]) {
    const evidence = lines.filter(line => pattern.test(`${/Board$/i.test(line.tag) ? "" : line.tag} ${line.message}`));
    const hasError = evidence.some(line => line.level === "E");
    report.push(result(title, evidence, `${evidence.length} relevant message${evidence.length === 1 ? "" : "s"}${hasError ? ", including errors" : ""}. Presence is not a functional test.`, hasError ? "Investigate" : "Observed"));
  }
  return report;
}
