import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RunsToolbar } from "./RunsToolbar";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const props = { search: "", kind: "", status: "", from: "", to: "" };

it("shows typing immediately and commits only the final search after 300ms", () => {
  const onChange = vi.fn();
  render(<RunsToolbar {...props} onChange={onChange} onClear={vi.fn()} />);
  const input = screen.getByRole("textbox");
  for (const value of ["r", "re", "result.csv"]) {
    fireEvent.change(input, { target: { value } });
    act(() => vi.advanceTimersByTime(100));
  }
  expect(input).toHaveValue("result.csv");
  expect(onChange).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(200));
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ search: "result.csv" }, true);
});

it("cancels pending edits when the URL changes or the toolbar unmounts", () => {
  const onChange = vi.fn();
  const view = render(<RunsToolbar {...props} onChange={onChange} onClear={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "pending" } });
  view.rerender(<RunsToolbar {...props} search="restored" onChange={onChange} onClear={vi.fn()} />);
  act(() => vi.advanceTimersByTime(300));
  expect(screen.getByRole("textbox")).toHaveValue("restored");
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "abandoned" } });
  view.unmount();
  act(() => vi.advanceTimersByTime(300));
  expect(onChange).not.toHaveBeenCalled();
});

it("clear cancels a pending edit instead of restoring it later", () => {
  const onChange = vi.fn();
  const onClear = vi.fn();
  render(<RunsToolbar {...props} onChange={onChange} onClear={onClear} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "pending" } });
  fireEvent.click(screen.getByRole("button"));
  act(() => vi.advanceTimersByTime(300));
  expect(screen.getByRole("textbox")).toHaveValue("");
  expect(onClear).toHaveBeenCalledOnce();
  expect(onChange).not.toHaveBeenCalled();
});
