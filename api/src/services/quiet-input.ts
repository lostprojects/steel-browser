// Native input and screenshots for one session's display. Do not send CDP Input
// events or shell commands containing page text, credentials, or filenames.
import { spawn } from "node:child_process";

export type RunX = (args: string[], text?: string) => Promise<Buffer>;

export function runDisplay(
  display: string,
  command: string,
  args: string[],
  text?: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, DISPLAY: display },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.on("data", (b: Buffer) => chunks.push(b));
    child.stderr.on("data", (b: Buffer) => errors.push(b));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else
        reject(
          new Error(`${command} failed (${code}): ${Buffer.concat(errors).toString().slice(-500)}`),
        );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });
}

const MODIFIERS = [
  [1, "Alt_L"],
  [2, "Control_L"],
  [4, "Super_L"],
  [8, "Shift_L"],
] as const;
const KEYS: Record<string, string> = {
  Enter: "Return",
  Backspace: "BackSpace",
  Escape: "Escape",
  Tab: "Tab",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "Prior",
  PageDown: "Next",
  Control: "Control_L",
  Shift: "Shift_L",
  Alt: "Alt_L",
  Meta: "Super_L",
  " ": "space",
  "\n": "Return",
  "\t": "Tab",
  "-": "minus",
  "=": "equal",
  "+": "plus",
  ";": "semicolon",
  ":": "colon",
  "'": "apostrophe",
  '"': "quotedbl",
  "[": "bracketleft",
  "]": "bracketright",
  "{": "braceleft",
  "}": "braceright",
  ",": "comma",
  ".": "period",
  "/": "slash",
  "\\": "backslash",
  "?": "question",
  "!": "exclam",
  "@": "at",
  "#": "numbersign",
  $: "dollar",
  "%": "percent",
  "^": "asciicircum",
  "&": "ampersand",
  "*": "asterisk",
  "(": "parenleft",
  ")": "parenright",
  _: "underscore",
  "`": "grave",
  "~": "asciitilde",
  "|": "bar",
  "<": "less",
  ">": "greater",
};

export class QuietInput {
  private position = { x: 0, y: 0 };
  private modifiers = 0;
  private heldModifiers = 0;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly run: RunX;

  constructor(
    readonly display: string,
    private width: number,
    private height: number,
    run?: RunX,
  ) {
    this.run = run ?? ((args, text) => runDisplay(display, "xdotool", args, text));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.serial.then(fn);
    this.serial = result.catch(() => undefined);
    return result;
  }

  private async setModifiers(wanted: number) {
    for (const [bit, key] of MODIFIERS) {
      if ((this.modifiers & bit) !== (wanted & bit))
        await this.run([wanted & bit ? "keydown" : "keyup", key]);
    }
    this.modifiers = wanted;
  }

  async mouse(params: Record<string, any>, offset: { x: number; y: number }) {
    return this.enqueue(async () => {
      const x = Math.round(Number(params.x) + offset.x);
      const y = Math.round(Number(params.y) + offset.y);
      if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x >= this.width || y >= this.height)
        throw new Error("Pointer coordinate is outside this session's display");
      await this.setModifiers(params.modifiers ?? this.heldModifiers);
      const from = this.position;
      const distance = Math.hypot(x - from.x, y - from.y);
      const steps = Math.min(12, Math.max(1, Math.ceil(distance / 60)));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const bend = Math.sin(Math.PI * t) * Math.min(20, distance / 12);
        const px = Math.max(
          0,
          Math.min(this.width - 1, Math.round(from.x + (x - from.x) * t + bend)),
        );
        const py = Math.max(
          0,
          Math.min(this.height - 1, Math.round(from.y + (y - from.y) * t - bend)),
        );
        await this.run(["mousemove", "--sync", String(px), String(py)]);
        if (steps > 1) await new Promise((r) => setTimeout(r, 8));
      }
      this.position = { x, y };
      const button = { left: "1", middle: "2", right: "3" }[params.button as string] ?? "1";
      if (params.type === "mousePressed") await this.run(["mousedown", button]);
      else if (params.type === "mouseReleased") await this.run(["mouseup", button]);
      else if (params.type === "mouseWheel") {
        for (const [delta, negative, positive] of [
          [params.deltaY ?? 0, "4", "5"],
          [params.deltaX ?? 0, "6", "7"],
        ] as const) {
          if (delta)
            await this.run([
              "click",
              "--repeat",
              String(Math.min(50, Math.ceil(Math.abs(delta) / 100))),
              "--delay",
              "30",
              delta < 0 ? negative : positive,
            ]);
        }
      }
      if (params.type !== "mousePressed") await this.setModifiers(this.heldModifiers);
      return {};
    });
  }

  async key(params: Record<string, any>) {
    return this.enqueue(async () => {
      const name = String(params.key ?? "");
      const modifier = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }[name];
      if (modifier) {
        this.heldModifiers =
          params.type === "keyUp" ? this.heldModifiers & ~modifier : this.heldModifiers | modifier;
        await this.setModifiers(this.heldModifiers);
        return {};
      }
      const key =
        KEYS[name] ??
        (/^(?:F\d{1,2}|[A-Za-z0-9])$/.test(name)
          ? name
          : [...name].length === 1
          ? `U${name.codePointAt(0)!.toString(16).padStart(4, "0")}`
          : null);
      if (!key) throw new Error(`Unsupported X11 key: ${name}`);
      await this.setModifiers(params.modifiers ?? this.heldModifiers);
      await this.run([params.type === "keyUp" ? "keyup" : "keydown", key]);
      if (params.type === "keyUp") await this.setModifiers(this.heldModifiers);
      return {};
    });
  }

  async text(text: string) {
    return this.enqueue(async () => {
      await this.setModifiers(0);
      await this.run(["type", "--delay", "25", "--file", "-"], text);
      await this.setModifiers(this.heldModifiers);
      return {};
    });
  }

  async screenshot(format = "png") {
    if (format !== "png" && format !== "jpeg" && format !== "webp")
      throw new Error("Unsupported image format");
    const data = await runDisplay(this.display, "ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "x11grab",
      "-video_size",
      `${this.width}x${this.height}`,
      "-i",
      this.display,
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      format === "jpeg" ? "mjpeg" : format === "webp" ? "libwebp" : "png",
      "pipe:1",
    ]);
    return { data: data.toString("base64") };
  }
}
