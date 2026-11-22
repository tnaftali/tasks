// Vercel function: /api/<b|i>/<id> -> the shared relay in ../../main.js.
import { handle } from "../../main.js";
export default { fetch: (req) => handle(req, fetch, "/api") };
