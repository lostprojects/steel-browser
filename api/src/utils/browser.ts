import fs from "fs";
import path from "path";
import { env } from "../env.js";

// Browser and display helpers need OS settings, not the service's vault, API or
// proxy credentials. Keep this list explicit so future service secrets stay out.
export function browserProcessEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const allowed =
    /^(?:PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LANGUAGE|LC_[A-Z_]+|TZ|DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|XDG_(?:CONFIG_HOME|CACHE_HOME|DATA_HOME|DATA_DIRS|CONFIG_DIRS|RUNTIME_DIR)|FONTCONFIG_(?:PATH|FILE)|LD_LIBRARY_PATH|LIBGL_DRIVERS_PATH|LIBGL_ALWAYS_SOFTWARE|MESA_LOADER_DRIVER_OVERRIDE|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|SystemRoot|SYSTEMROOT|WINDIR|LOCALAPPDATA|APPDATA|USERPROFILE|ProgramFiles|__CF_USER_TEXT_ENCODING)$/;
  return Object.fromEntries(
    Object.entries({ ...process.env, ...overrides }).filter(
      ([key, value]) => value !== undefined && allowed.test(key),
    ),
  );
}

export const getChromeExecutablePath = () => {
  if (env.CHROME_EXECUTABLE_PATH) {
    const executablePath = env.CHROME_EXECUTABLE_PATH;
    const normalizedPath = path.normalize(executablePath);
    if (!fs.existsSync(normalizedPath)) {
      console.warn(`Your custom chrome executable at ${normalizedPath} does not exist`);
    } else {
      return executablePath;
    }
  }

  if (process.platform === "win32") {
    const programFilesPath = `${process.env["ProgramFiles"]}\\Google\\Chrome\\Application\\chrome.exe`;
    const programFilesX86Path = `C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe`;

    if (fs.existsSync(programFilesPath)) {
      return programFilesPath;
    } else if (fs.existsSync(programFilesX86Path)) {
      return programFilesX86Path;
    }
  }

  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }

  return "/usr/bin/google-chrome-stable";
};

/**
 * Default Chrome plugin preferences. Upstream turns the PDF viewer off so PDFs
 * download, which also leaves navigator.plugins empty, unlike any desktop
 * Chrome. ENABLE_PDF_VIEWER=true keeps the viewer and its five plugin entries.
 */
export function defaultPluginPreferences() {
  return env.ENABLE_PDF_VIEWER
    ? { plugins: { always_open_pdf_externally: false, plugins_disabled: [] as string[] } }
    : { plugins: { always_open_pdf_externally: true, plugins_disabled: ["Chrome PDF Viewer"] } };
}
