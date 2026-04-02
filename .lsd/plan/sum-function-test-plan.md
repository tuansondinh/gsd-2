# Test Plan: `sum` Function

**Date:** 2026-04-02  
**Status:** Draft  
**Scope:** Unit tests for a basic `sum(a, b)` function

---

## Function Under Test

```ts
function sum(a: number, b: number): number
```

Adds two numbers and returns their total.

---

## Test Cases

### ✅ Happy Path

| # | Description | Input | Expected Output |
|---|-------------|-------|-----------------|
| 1 | Two positive integers | `sum(2, 3)` | `5` |
| 2 | Two large integers | `sum(1000, 9000)` | `10000` |
| 3 | Identity: adding zero | `sum(5, 0)` | `5` |
| 4 | Commutative property | `sum(3, 7) === sum(7, 3)` | `true` |

### 🔢 Negative Numbers

| # | Description | Input | Expected Output |
|---|-------------|-------|-----------------|
| 5 | Two negatives | `sum(-2, -3)` | `-5` |
| 6 | Positive + negative | `sum(10, -4)` | `6` |
| 7 | Result of zero | `sum(-5, 5)` | `0` |

### 🔣 Floats / Decimals

| # | Description | Input | Expected Output |
|---|-------------|-------|-----------------|
| 8 | Two decimals | `sum(1.1, 2.2)` | `≈ 3.3` (float tolerance) |
| 9 | Integer + decimal | `sum(3, 0.5)` | `3.5` |

### 🚧 Edge Cases

| # | Description | Input | Expected Output |
|---|-------------|-------|-----------------|
| 10 | Both zero | `sum(0, 0)` | `0` |
| 11 | Very large numbers | `sum(Number.MAX_SAFE_INTEGER, 1)` | `Number.MAX_SAFE_INTEGER + 1` |
| 12 | Very small numbers | `sum(Number.MIN_SAFE_INTEGER, -1)` | `Number.MIN_SAFE_INTEGER - 1` |

### ❌ Invalid Input (if type-checking is loose / JS runtime)

| # | Description | Input | Expected Behavior |
|---|-------------|-------|-------------------|
| 13 | String inputs | `sum("a", "b")` | `NaN` or type error |
| 14 | Null / undefined | `sum(null, undefined)` | `NaN` or type error |

> **Note:** Cases 13–14 only apply if the implementation allows untyped input (e.g. plain JavaScript). In strict TypeScript, these are compile-time errors.

---

## Acceptance Criteria

- [ ] All happy-path tests pass
- [ ] Negative number tests pass
- [ ] Float tests pass with appropriate tolerance (`toBeCloseTo` or epsilon check)
- [ ] Edge cases for integer overflow are documented/handled
- [ ] Invalid input behavior is explicitly defined and tested

---

## Implementation Notes

- Use `toBeCloseTo(value, precision)` for float comparisons to avoid IEEE 754 issues
- Tests should be pure (no side effects, no I/O)
- Recommended framework: **Jest** or **Vitest**

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/sum.ts` | Implementation |
| `src/sum.test.ts` | Test suite |
