import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BudgetGauge } from "./BudgetGauge";
import type { RetryState } from "./RetryBadge";
import { RetryBadge } from "./RetryBadge";
import { TokenUsageBar } from "./TokenUsageBar";

describe("BudgetGauge", () => {
  it("shows No limit when budgetUsd is not set", () => {
    render(<BudgetGauge spent={1.5} />);
    expect(screen.getByText("No limit")).toBeTruthy();
  });
  it("shows percentage when budgetUsd is set", () => {
    render(<BudgetGauge spent={1} budgetUsd={4} />);
    expect(screen.getByText(/25%/)).toBeTruthy();
  });
  it("clamps negative spent to zero", () => {
    render(<BudgetGauge spent={-5} budgetUsd={10} />);
    expect(screen.getByText(/0%/)).toBeTruthy();
  });
  it("shows Budget label in md size", () => {
    render(<BudgetGauge spent={1} budgetUsd={4} size="md" />);
    expect(screen.getByText("Budget")).toBeTruthy();
  });
  it("hides Budget label in sm size", () => {
    render(<BudgetGauge spent={1} budgetUsd={4} size="sm" />);
    expect(screen.queryByText("Budget")).toBeNull();
  });
});

describe("TokenUsageBar", () => {
  it("renders null when limit is zero", () => {
    const { container } = render(<TokenUsageBar current={100} limit={0} />);
    expect(container.firstChild).toBeNull();
  });
  it("renders bar when limit > 0", () => {
    const { container } = render(<TokenUsageBar current={50} limit={200} />);
    expect(container.firstChild).not.toBeNull();
  });
  it("shows label when provided", () => {
    render(<TokenUsageBar current={50} limit={200} label="Tokens" />);
    expect(screen.getByText("Tokens")).toBeTruthy();
  });
  it("uses formatValue for display", () => {
    render(<TokenUsageBar current={1000} limit={5000} formatValue={(n) => `${n}t`} />);
    expect(screen.getByText(/1000t/)).toBeTruthy();
  });
});

describe("RetryBadge", () => {
  const retry: RetryState = { attempt: 2, error_status: 429, error: "rate limited" };
  it("renders attempt in non-compact mode", () => {
    render(<RetryBadge retry={retry} />);
    expect(screen.getByText(/attempt 2/)).toBeTruthy();
  });
  it("renders compact version", () => {
    render(<RetryBadge retry={retry} compact />);
    expect(screen.getByText(/Retry #2/)).toBeTruthy();
  });
  it("has role=status", () => {
    render(<RetryBadge retry={retry} />);
    expect(screen.getByRole("status")).toBeTruthy();
  });
  it("shows error message in non-compact mode", () => {
    render(<RetryBadge retry={retry} />);
    expect(screen.getByText("rate limited")).toBeTruthy();
  });
});
