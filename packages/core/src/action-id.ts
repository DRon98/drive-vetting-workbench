import { createHash } from "node:crypto";
import { ActionTypeSchema, type ActionType } from "./action-types.js";

export interface ActionIdentityInput {
  readonly desiredState: Readonly<Record<string, unknown>>;
  readonly displayOrder?: number;
  readonly planIdentity: string;
  readonly targetId: string;
  readonly type: ActionType;
}

const nonJsonIdentityMessage =
  "Action identity inputs must be losslessly JSON-serializable.";

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function normalizeJson(
  value: unknown,
  ancestors = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(nonJsonIdentityMessage);
    }
    return value;
  }

  if (typeof value === "string") {
    return value.normalize("NFC");
  }

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError(nonJsonIdentityMessage);
    }
    if (ancestors.has(value)) {
      throw new TypeError(nonJsonIdentityMessage);
    }

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== value.length + 1) {
      throw new TypeError(nonJsonIdentityMessage);
    }

    ancestors.add(value);
    try {
      const normalized: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          throw new TypeError(nonJsonIdentityMessage);
        }
        normalized.push(normalizeJson(descriptor.value, ancestors));
      }
      return normalized;
    } finally {
      ancestors.delete(value);
    }
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(nonJsonIdentityMessage);
    }
    if (ancestors.has(value)) {
      throw new TypeError(nonJsonIdentityMessage);
    }

    const stringKeys: string[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new TypeError(nonJsonIdentityMessage);
      }
      stringKeys.push(key);
    }

    ancestors.add(value);
    try {
      const normalizedEntries = stringKeys
        .map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (
            descriptor === undefined ||
            !descriptor.enumerable ||
            !("value" in descriptor)
          ) {
            throw new TypeError(nonJsonIdentityMessage);
          }
          return [
            key.normalize("NFC"),
            normalizeJson(descriptor.value, ancestors),
          ] as const;
        })
        .sort(([left], [right]) => compareCodeUnits(left, right));

      const normalizedKeys = normalizedEntries.map(([key]) => key);
      if (new Set(normalizedKeys).size !== normalizedKeys.length) {
        throw new TypeError(nonJsonIdentityMessage);
      }
      return Object.fromEntries(normalizedEntries);
    } finally {
      ancestors.delete(value);
    }
  }

  throw new TypeError(nonJsonIdentityMessage);
}

export function createActionId(input: ActionIdentityInput): string {
  const type = ActionTypeSchema.parse(input.type);
  const identity = normalizeJson({
    desiredState: input.desiredState,
    planIdentity: input.planIdentity,
    targetId: input.targetId,
    type,
  });
  const digest = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 32);

  return `act_${digest}`;
}
