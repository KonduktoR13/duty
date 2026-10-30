import { it, expect, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { eventSchema } from "../src/personal-types";
it("upgrades populated v4 atomically, retains personal records after deleting only the PDF, and restores v2", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const old = await new Promise<IDBDatabase>((r, j) => {
    const q = indexedDB.open("my-shifts", 4);
    q.onupgradeneeded = () => {
      for (const k of ["months", "pdfs", "settings", "syncs", "revisions"])
        q.result.createObjectStore(
          k,
          ["months", "syncs", "revisions"].includes(k)
            ? { keyPath: "id" }
            : undefined,
        );
    };
    q.onsuccess = () => r(q.result);
    q.onerror = () => j(q.error);
  });
  await new Promise<void>((r, j) => {
    const t = old.transaction(["settings", "months"], "readwrite");
    t.objectStore("settings").put("D12", "deltaNumber");
    t.objectStore("months").put({
      id: "2026-10",
      deltaNumber: "D12",
      shifts: [],
      hash: "keep",
    });
    t.oncomplete = () => r();
    t.onerror = () => j(t.error);
  });
  old.close();
  const { storage } = await import("../src/db");
  expect(await storage.setting("deltaNumber")).toBe("D12");
  expect((await storage.months())[0].hash).toBe("keep");
  const note = eventSchema.parse({
    id: "a",
    kind: "note",
    start: "2026-10-30",
    owner: "D12",
    title: "Training",
    createdAt: 1,
    updatedAt: 1,
  });
  await storage.putEvent(note);
  await storage.putPayroll({
    id: "2026-09",
    wage: 2170,
    source: "palgateatis",
  });
  await storage.remove("2026-10");
  expect(await storage.events()).toEqual([note]);
  const saved = await storage.snapshot();
  await storage.clear();
  expect(await storage.events()).toEqual([]);
  await storage.restore(saved);
  expect(await storage.events()).toEqual([note]);
  expect((await storage.payroll())[0].wage).toBe(2170);
  vi.unstubAllGlobals();
});
