// Explicit maintenance for unpublished uploads older than 24 hours. Run only
// with the central library's environment; published files are never selected.
import { configuredLibrary } from "../build/services/library/service.js";
import { ContentLibrary } from "../build/services/library/library.js";
const library = configuredLibrary();
if (!(library instanceof ContentLibrary))
  throw new Error("Run cleanup in the central library environment");
try {
  console.log(JSON.stringify(await library.prunePending(), null, 2));
} finally {
  await library.close();
}
