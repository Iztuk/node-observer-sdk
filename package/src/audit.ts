import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYAML } from "yaml";

/*
 * OpenAPI types
 */

export interface OpenAPIDocument {
  openapi: string;
  info: OpenAPIInfo;
  servers?: OpenAPIServer[];
  paths: Record<string, OpenAPIPathItem>;
  components?: OpenAPIComponents;
}

export interface OpenAPIInfo {
  title: string;
  version: string;
  description?: string;
  termsOfService?: string;
}

export interface OpenAPIServer {
  url: string;
  description?: string;
  variables?: Record<string, ServerVariable>;
}

export interface ServerVariable {
  enum?: string[];
  default: string;
  description?: string;
}

export interface OpenAPIPathItem {
  summary?: string;
  description?: string;

  get?: OpenAPIOperation;
  post?: OpenAPIOperation;
  put?: OpenAPIOperation;
  patch?: OpenAPIOperation;
  delete?: OpenAPIOperation;
  head?: OpenAPIOperation;
  options?: OpenAPIOperation;
  trace?: OpenAPIOperation;

  parameters?: OpenAPIParameter[];
}

export interface OpenAPIOperation {
  tags?: string[];
  operationId?: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;

  parameters?: OpenAPIParameter[];
  requestBody?: OpenAPIRequestBody;
  responses: Record<string, OpenAPIResponse>;

  security?: Array<Record<string, string[]>>;
}

export interface OpenAPIParameter {
  name: string;
  in: string;
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  schema?: OpenAPISchema;
  example?: unknown;
}

export interface OpenAPIRequestBody {
  description?: string;
  required?: boolean;
  content?: Record<string, OpenAPIMediaType>;
}

export interface OpenAPIResponse {
  description: string;
  headers?: Record<string, OpenAPIHeader>;
  content?: Record<string, OpenAPIMediaType>;
}

export interface OpenAPIHeader {
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  schema?: OpenAPISchema;
  example?: unknown;
}

export interface OpenAPIMediaType {
  schema?: OpenAPISchema;
  example?: unknown;
  examples?: Record<string, unknown>;
  encoding?: Record<string, unknown>;
}

export interface OpenAPIComponents {
  schemas?: Record<string, OpenAPISchema>;
  responses?: Record<string, OpenAPIResponse>;
  parameters?: Record<string, OpenAPIParameter>;
  requestBodies?: Record<string, OpenAPIRequestBody>;
  headers?: Record<string, OpenAPIHeader>;
  securitySchemes?: Record<string, OpenAPISecurityScheme>;
}

export interface OpenAPISecurityScheme {
  type: string;
  description?: string;
  name?: string;
  in?: string;
  scheme?: string;
  bearerFormat?: string;
  flows?: Record<string, unknown>;
  openIdConnectUrl?: string;
}

export interface OpenAPISchema {
  $ref?: string;

  type?: string;
  format?: string;
  title?: string;
  description?: string;
  default?: unknown;
  example?: unknown;

  properties?: Record<string, OpenAPISchema>;
  required?: string[];
  items?: OpenAPISchema;

  enum?: unknown[];

  nullable?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;

  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;

  pattern?: string;

  additionalProperties?: unknown;

  allOf?: OpenAPISchema[];
  oneOf?: OpenAPISchema[];
  anyOf?: OpenAPISchema[];
  not?: OpenAPISchema;
}

/*
 * Host-rule types
 */

export type JobType = "request" | "response" | "failure";

export type RuleType = "path" | "query" | "header" | "body_field";

export type TargetType = "query" | "header" | "path" | "field";

export interface HostRulesDocument {
  rules: Record<string, HostRule>;
}

export interface HostRule {
  enabled: boolean;
  applies_to: JobType[];
  type: RuleType;
  description?: string;
  match: RuleMatch;
  finding: RuleFinding;
}

export interface RuleMatch {
  paths?: string[];
  methods?: string[];
  headers?: Record<string, string[]>;
  query_params?: Record<string, string[]>;
  fields?: string[];
  patterns?: RulePattern[];
}

export interface RulePattern {
  target: TargetType;
  name?: string;
  pattern: string;

  /*
   * Runtime-only compiled expression.
   *
   * This is deliberately non-enumerable when assigned so it is not
   * included in JSON.stringify().
   */
  regex?: RegExp;
}

export interface RuleFinding {
  title: string;
  message: string;
}

/*
 * OpenAPI loading
 */

export async function loadOpenAPIDocument(
  filePath: string,
): Promise<OpenAPIDocument> {
  const document = await loadDocument(filePath, "OpenAPI");

  assertObject(
    document,
    "invalid OpenAPI contract: document must be an object",
  );

  const openAPIDocument = document as unknown as OpenAPIDocument;

  validateOpenAPIContractStructure(openAPIDocument);

  return openAPIDocument;
}

function validateOpenAPIContractStructure(document: OpenAPIDocument): void {
  if (!isNonEmptyString(document.openapi)) {
    throw new Error("invalid OpenAPI contract: missing openapi field");
  }

  if (!document.info || typeof document.info !== "object") {
    throw new Error("invalid OpenAPI contract: missing info");
  }

  if (!isNonEmptyString(document.info.title)) {
    throw new Error("invalid OpenAPI contract: missing info.title");
  }

  if (!isNonEmptyString(document.info.version)) {
    throw new Error("invalid OpenAPI contract: missing info.version");
  }

  if (
    !document.paths ||
    typeof document.paths !== "object" ||
    Array.isArray(document.paths) ||
    Object.keys(document.paths).length === 0
  ) {
    throw new Error("invalid OpenAPI contract: missing paths");
  }

  for (const [routePath, pathItem] of Object.entries(document.paths)) {
    if (!routePath.trim()) {
      throw new Error("invalid OpenAPI contract: empty path");
    }

    if (!routePath.startsWith("/")) {
      throw new Error(
        `invalid OpenAPI contract: path "${routePath}" must start with '/'`,
      );
    }

    if (
      !pathItem ||
      typeof pathItem !== "object" ||
      !hasOpenAPIOperation(pathItem)
    ) {
      throw new Error(
        `invalid OpenAPI contract: path "${routePath}" has no operations`,
      );
    }
  }
}

function hasOpenAPIOperation(pathItem: OpenAPIPathItem): boolean {
  return (
    pathItem.get !== undefined ||
    pathItem.post !== undefined ||
    pathItem.put !== undefined ||
    pathItem.patch !== undefined ||
    pathItem.delete !== undefined ||
    pathItem.head !== undefined ||
    pathItem.options !== undefined ||
    pathItem.trace !== undefined
  );
}

/*
 * Host-rule loading
 */

export async function loadRulesDocument(
  filePath: string,
): Promise<HostRulesDocument> {
  const document = await loadDocument(filePath, "Host Rules");

  assertObject(
    document,
    "invalid Host Rules document: document must be an object",
  );

  const hostRulesDocument = document as unknown as HostRulesDocument;

  validateRulesDocument(hostRulesDocument);
  compileRulePatterns(hostRulesDocument);

  return hostRulesDocument;
}

function validateRulesDocument(document: HostRulesDocument): void {
  if (document.rules === undefined || document.rules === null) {
    document.rules = {};
    return;
  }

  if (typeof document.rules !== "object" || Array.isArray(document.rules)) {
    throw new Error("invalid Host Rules document: rules must be an object");
  }

  for (const [ruleID, rule] of Object.entries(document.rules)) {
    if (!ruleID.trim()) {
      throw new Error("host rule id cannot be empty");
    }

    if (!rule || typeof rule !== "object") {
      throw new Error(`host rule "${ruleID}" must be an object`);
    }

    if (!isNonEmptyString(rule.type)) {
      throw new Error(`host rule "${ruleID}" missing type`);
    }

    if (!isValidRuleType(rule.type)) {
      throw new Error(
        `host rule "${ruleID}" has unsupported type "${String(rule.type)}"`,
      );
    }

    if (!rule.match || typeof rule.match !== "object") {
      throw new Error(`host rule "${ruleID}" missing match`);
    }

    if (!rule.finding || typeof rule.finding !== "object") {
      throw new Error(`host rule "${ruleID}" missing finding`);
    }

    if (!isNonEmptyString(rule.finding.title)) {
      throw new Error(`host rule "${ruleID}" missing finding.title`);
    }

    if (!isNonEmptyString(rule.finding.message)) {
      throw new Error(`host rule "${ruleID}" missing finding.message`);
    }

    for (const pattern of rule.match.patterns ?? []) {
      validateRulePattern(ruleID, rule.type, pattern);
    }
  }
}

function validateRulePattern(
  ruleID: string,
  ruleType: RuleType,
  pattern: RulePattern,
): void {
  if (!pattern || typeof pattern !== "object") {
    throw new Error(`host rule "${ruleID}" has an invalid pattern`);
  }

  if (!isNonEmptyString(pattern.target)) {
    throw new Error(`host rule "${ruleID}" has pattern with missing target`);
  }

  if (!isValidTargetType(pattern.target)) {
    throw new Error(
      `host rule "${ruleID}" has unsupported pattern target "${String(pattern.target)}"`,
    );
  }

  if (!targetAllowedForRuleType(ruleType, pattern.target)) {
    throw new Error(
      `host rule "${ruleID}" has pattern target "${pattern.target}" ` +
        `that is not allowed for rule type "${ruleType}"`,
    );
  }

  if (!isNonEmptyString(pattern.pattern)) {
    throw new Error(`host rule "${ruleID}" has pattern with missing regex`);
  }

  try {
    compileRegex(pattern.pattern);
  } catch (error) {
    throw new Error(
      `host rule "${ruleID}" has invalid regex pattern ` +
        `"${pattern.pattern}"`,
      { cause: error },
    );
  }
}

function compileRulePatterns(document: HostRulesDocument): void {
  for (const [ruleID, rule] of Object.entries(document.rules)) {
    for (const pattern of rule.match.patterns ?? []) {
      let compiled: RegExp;

      try {
        compiled = compileRegex(pattern.pattern);
      } catch (error) {
        throw new Error(
          `host rule "${ruleID}" has invalid regex pattern ` +
            `"${pattern.pattern}"`,
          { cause: error },
        );
      }

      /*
       * Similar to json:"-" in Go: the compiled RegExp exists at
       * runtime but is excluded from JSON.stringify().
       */
      Object.defineProperty(pattern, "regex", {
        value: compiled,
        enumerable: false,
        configurable: false,
        writable: false,
      });
    }
  }
}

/*
 * Go accepts inline modifiers such as (?i). JavaScript does not
 * accept that syntax directly, so translate the common leading
 * modifiers into JavaScript RegExp flags.
 */
function compileRegex(pattern: string): RegExp {
  let source = pattern;
  let flags = "";

  const inlineFlags = source.match(/^\(\?([ims]+)\)/);

  if (inlineFlags) {
    source = source.slice(inlineFlags[0].length);
    flags = inlineFlags[1];
  }

  return new RegExp(source, flags);
}

function isValidRuleType(ruleType: unknown): ruleType is RuleType {
  return (
    ruleType === "path" ||
    ruleType === "query" ||
    ruleType === "header" ||
    ruleType === "body_field"
  );
}

function isValidTargetType(target: unknown): target is TargetType {
  return (
    target === "query" ||
    target === "header" ||
    target === "path" ||
    target === "field"
  );
}

function targetAllowedForRuleType(
  ruleType: RuleType,
  target: TargetType,
): boolean {
  switch (ruleType) {
    case "query":
      return target === "query";

    case "header":
      return target === "header";

    case "path":
      return target === "path";

    case "body_field":
      return target === "field";
  }
}

/*
 * Shared file parsing
 */

async function loadDocument(
  filePath: string,
  documentName: string,
): Promise<unknown> {
  let data: string;

  try {
    data = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`failed to read ${documentName} document: ${filePath}`, {
      cause: error,
    });
  }

  const extension = path.extname(filePath).toLowerCase();

  try {
    switch (extension) {
      case ".json":
        return JSON.parse(data) as unknown;

      case ".yaml":
      case ".yml":
        return parseYAML(data) as unknown;

      default:
        throw new Error(
          `unsupported ${documentName} document type: ${filePath}`,
        );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("unsupported ")) {
      throw error;
    }

    const format = extension === ".json" ? "JSON" : "YAML";

    throw new Error(`parse ${documentName} ${format} document`, {
      cause: error,
    });
  }
}

function assertObject(
  value: unknown,
  message: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
