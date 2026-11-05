/**
 * Node Role Classifier for Deterministic Mermaid Visualization
 * 
 * Classifies nodes into roles (UI, API, Data, Auth, Infra) based on file paths,
 * imports, exports, and code patterns. Used for role-based styling in mermaid graphs.
 */

export type NodeRole =
  | "ui"        // React / Next.js components / pages
  | "api"       // Next.js API routes, server handlers, express-like
  | "data"      // db.ts, prisma, repos, supabase, mongoose
  | "auth"      // auth.ts, next-auth, jwt, middleware
  | "infra"     // utils, adapters, http, fs, runtime
  | "unknown";  // everything else

export interface NodeContext {
  id: string;              // internal graph node id
  filePath?: string;       // e.g. "src/pages/api/users.ts"
  fileName?: string;       // if extracted separately
  code?: string;          // full or partial source
  imports?: string[];      // normalized import specifiers, e.g. ["react", "next/navigation", "@prisma/client"]
  exports?: string[];      // e.g. ["GET", "POST", "default handler"]
  symbolName?: string;     // optional, e.g. "getUser", "UserPage"
  metadata?: Record<string, any>; // room for future info
}

/**
 * Classifies a node into a role based on deterministic rules.
 * First match wins - rules are checked in order of priority.
 * API routes are checked before UI to ensure /pages/api/ and /app/api/ are classified as API.
 */
export function classifyNodeRole(node: NodeContext): NodeRole {
  // Check API first to catch /pages/api/ and /app/api/ before UI patterns
  if (isApi(node)) return "api";
  if (isUi(node)) return "ui";
  if (isAuth(node)) return "auth";
  if (isData(node)) return "data";
  if (isInfra(node)) return "infra";
  return "unknown";
}

function isUi(node: NodeContext): boolean {
  const fp = node.filePath || "";
  const imps = node.imports || [];
  const code = node.code || "";
  const name = node.symbolName || "";
  const fn = node.fileName || fp.split("/").pop() || "";

  // Exclude API routes from UI classification
  if (fp.includes("/api/") || fp.includes("/pages/api/") || fp.includes("/app/api/")) {
    return false;
  }

  // Check file path patterns (excluding API routes)
  if (fp.includes("/pages/") || fp.includes("/app/") || fp.includes("/components/")) return true;
  
  // Check file extension
  if (fn.endsWith(".tsx") || fn.endsWith(".jsx")) return true;
  
  // Check imports
  if (imps.some(s => s === "react" || s.startsWith("next/"))) return true;
  
  // Check symbol name patterns
  if (name.endsWith("Page") || name.endsWith("Component")) return true;
  
  // Check code patterns (rough but deterministic)
  if (code.includes("function ") && code.includes("return (")) return true;

  return false;
}

function isApi(node: NodeContext): boolean {
  const fp = node.filePath || "";
  const exps = node.exports || [];
  const code = node.code || "";

  // Check API route patterns
  if (
    fp.includes("/pages/api/") ||
    fp.includes("/src/pages/api/") ||
    fp.includes("/app/api/") ||
    (fp.includes("/api/") && !fp.includes("/components/"))
  ) return true;

  // Check Next.js route handler exports
  if (exps.some(e => ["GET", "POST", "PUT", "DELETE", "PATCH"].includes(e))) return true;

  // Check handler function pattern
  if (code.includes("export default function handler(")) return true;

  return false;
}

function isAuth(node: NodeContext): boolean {
  const imps = node.imports || [];
  const fn = node.fileName || "";
  
  // Check auth-related imports
  if (imps.some(s => 
    s === "next-auth" || 
    s.startsWith("@auth/") || 
    s === "jsonwebtoken" || 
    s === "bcrypt"
  )) return true;
  
  // Check auth file names
  if (fn === "auth.ts" || fn === "auth.js" || fn === "middleware.ts" || fn === "middleware.js") return true;
  
  return false;
}

function isData(node: NodeContext): boolean {
  const imps = node.imports || [];
  const fn = node.fileName || "";
  const fp = node.filePath || "";
  
  // Check database/ORM imports
  if (imps.some(s =>
    s === "@prisma/client" ||
    s === "mongoose" ||
    s === "pg" ||
    s === "mysql2" ||
    s === "@supabase/supabase-js"
  )) return true;
  
  // Check data layer file names
  if (["db.ts", "db.js", "prisma.ts", "repository.ts", "repo.ts"].includes(fn)) return true;
  
  // Check file paths containing repository or db
  if (fp.includes("/repository/") || fp.includes("/repo/") || fp.includes("/db/")) return true;
  
  // Check if filename contains repository or repo
  if (fn.toLowerCase().includes("repository") || fn.toLowerCase().includes("repo")) return true;
  
  return false;
}

function isInfra(node: NodeContext): boolean {
  const imps = node.imports || [];
  const fn = node.fileName || "";
  const fp = node.filePath || "";
  
  // Check infrastructure imports
  if (imps.some(s => 
    s === "axios" || 
    s.startsWith("node:") || 
    s === "fs" || 
    s === "path" || 
    s === "crypto"
  )) return true;
  
  // Check infrastructure file name patterns
  if (
    fn.endsWith("service.ts") || 
    fn.endsWith("Service.ts") ||
    fn.endsWith("client.ts") || 
    fn.endsWith("Client.ts") ||
    fn.endsWith("util.ts") || 
    fn.endsWith("Util.ts") ||
    fn.endsWith("helper.ts") ||
    fn.endsWith("Helper.ts")
  ) return true;
  
  // Check file paths containing services, utils, lib
  if (fp.includes("/services/") || fp.includes("/utils/") || fp.includes("/lib/") || fp.includes("/helpers/")) return true;
  
  // Check if filename contains service, util, or client
  const fnLower = fn.toLowerCase();
  if (fnLower.includes("service") || fnLower.includes("util") || fnLower.includes("client")) return true;
  
  return false;
}

