/*! Adapted from @juicesharp/rpiv-todo 2.12.0
MIT License

Copyright (c) 2026 juicesharp

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import type { Task } from "../tool/types.js";

/**
 * Canonical state for the todo tool. Single source of truth — both the reducer
 * (`state/state-reducer.ts`) and the live store cell (`state/store.ts`) read
 * this shape. Replay (`state/replay.ts`) returns a fresh `TaskState`; the
 * lifecycle handlers in `index.ts` write it via `replaceState`.
 *
 * The shape is intentionally minimal — no derived caches or runtime cells.
 * Selectors in `state/selectors.ts` are pure of `TaskState` and own all
 * derivations (visible/grouped/counted/etc).
 */
export interface TaskState {
	tasks: Task[];
	nextId: number;
}

export const EMPTY_STATE: TaskState = { tasks: [], nextId: 1 };
