import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import { db, projectsTable, usersTable, pool } from "@workspace/db";
import type { Express } from "express";
import app from "../src/app";
import { createUser, makeApp } from "./helpers";

/**
 * Tests for the Projects & Tasks CRUD surface. Projects cascade-delete their
 * tasks, so cleanup only needs to remove the projects this suite creates. Each
 * test creates its own project(s) and asserts against them by id, so the shared
 * dev DB can hold unrelated rows without affecting results.
 *
 * `createdById` is an FK to users, so the app must be built with a real seeded
 * user id (the default `makeApp()` injects a random uuid that violates the FK).
 */

let featureApp: Express;
let seededUserId: string;
const createdProjectIds: string[] = [];

beforeAll(async () => {
  const { user } = await createUser({ role: "admin" });
  seededUserId = user.id;
  featureApp = makeApp({ role: "admin", userId: user.id });
});

async function createProject(name: string) {
  const res = await request(featureApp)
    .post("/projects")
    .send({ name });
  expect(res.status).toBe(201);
  createdProjectIds.push(res.body.id);
  return res.body;
}

afterAll(async () => {
  if (createdProjectIds.length) {
    await db
      .delete(projectsTable)
      .where(inArray(projectsTable.id, createdProjectIds));
  }
  if (seededUserId) {
    await db.delete(usersTable).where(eq(usersTable.id, seededUserId));
  }
  await pool.end();
});

describe("Projects & Tasks API", () => {
  it("creates a project with zeroed task aggregates", async () => {
    const project = await createProject("Test Project A");
    expect(project.name).toBe("Test Project A");
    expect(project.status).toBe("active");
    expect(project.taskCount).toBe(0);
    expect(project.completionPct).toBe(0);
  });

  it("rejects a project with no name", async () => {
    const res = await request(featureApp).post("/projects").send({});
    expect(res.status).toBe(400);
  });

  it("creates tasks and reflects them in project aggregates and completion %", async () => {
    const project = await createProject("Test Project B");

    const t1 = await request(featureApp)
      .post(`/projects/${project.id}/tasks`)
      .send({ title: "Task 1", estimatedMinutes: 120 });
    expect(t1.status).toBe(201);
    expect(t1.body.status).toBe("todo");
    expect(t1.body.completedAt).toBeNull();

    const t2 = await request(featureApp)
      .post(`/projects/${project.id}/tasks`)
      .send({ title: "Task 2", status: "done", estimatedMinutes: 60 });
    expect(t2.status).toBe(201);
    // Creating a task already in "done" stamps completedAt.
    expect(t2.body.completedAt).not.toBeNull();

    const list = await request(featureApp).get(
      `/projects/${project.id}/tasks`,
    );
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);

    // Re-fetch the project to verify aggregates: 2 tasks, 1 done => 50%.
    const projects = await request(featureApp).get("/projects");
    const refreshed = projects.body.find((p: any) => p.id === project.id);
    expect(refreshed.taskCount).toBe(2);
    expect(refreshed.doneCount).toBe(1);
    expect(refreshed.todoCount).toBe(1);
    expect(refreshed.estimatedMinutes).toBe(180);
    expect(refreshed.completionPct).toBe(50);
  });

  it("stamps and clears completedAt as task status transitions to/from done", async () => {
    const project = await createProject("Test Project C");
    const created = await request(featureApp)
      .post(`/projects/${project.id}/tasks`)
      .send({ title: "Toggle task" });
    const taskId = created.body.id;
    expect(created.body.completedAt).toBeNull();

    const done = await request(featureApp)
      .patch(`/tasks/${taskId}`)
      .send({ status: "done" });
    expect(done.status).toBe(200);
    expect(done.body.completedAt).not.toBeNull();

    const reopened = await request(featureApp)
      .patch(`/tasks/${taskId}`)
      .send({ status: "in_progress" });
    expect(reopened.status).toBe(200);
    expect(reopened.body.completedAt).toBeNull();
  });

  it("updates logged time on a task", async () => {
    const project = await createProject("Test Project D");
    const created = await request(featureApp)
      .post(`/projects/${project.id}/tasks`)
      .send({ title: "Logged task" });
    const taskId = created.body.id;

    const patched = await request(featureApp)
      .patch(`/tasks/${taskId}`)
      .send({ loggedMinutes: 90 });
    expect(patched.status).toBe(200);
    expect(patched.body.loggedMinutes).toBe(90);

    const projects = await request(featureApp).get("/projects");
    const refreshed = projects.body.find((p: any) => p.id === project.id);
    expect(refreshed.loggedMinutes).toBe(90);
  });

  it("deletes a task", async () => {
    const project = await createProject("Test Project E");
    const created = await request(featureApp)
      .post(`/projects/${project.id}/tasks`)
      .send({ title: "Doomed task" });
    const taskId = created.body.id;

    const del = await request(featureApp).delete(`/tasks/${taskId}`);
    expect(del.status).toBe(204);

    const list = await request(featureApp).get(
      `/projects/${project.id}/tasks`,
    );
    expect(list.body).toHaveLength(0);
  });

  it("filters projects by status", async () => {
    const project = await createProject("Test Project F");
    await request(featureApp)
      .patch(`/projects/${project.id}`)
      .send({ status: "archived" });

    const archived = await request(featureApp)
      .get("/projects")
      .query({ status: "archived" });
    expect(archived.status).toBe(200);
    expect(
      archived.body.some((p: any) => p.id === project.id),
    ).toBe(true);

    const active = await request(featureApp)
      .get("/projects")
      .query({ status: "active" });
    expect(active.body.some((p: any) => p.id === project.id)).toBe(false);
  });

  it("returns 404 when adding a task to a missing project", async () => {
    const res = await request(featureApp)
      .post("/projects/00000000-0000-0000-0000-000000000000/tasks")
      .send({ title: "Orphan" });
    expect(res.status).toBe(404);
  });

  it("deletes a project (cascading its tasks)", async () => {
    const project = await createProject("Test Project G");
    await request(featureApp)
      .post(`/projects/${project.id}/tasks`)
      .send({ title: "Child task" });

    const del = await request(featureApp).delete(`/projects/${project.id}`);
    expect(del.status).toBe(204);

    const tasks = await request(featureApp).get(
      `/projects/${project.id}/tasks`,
    );
    expect(tasks.status).toBe(404);
  });

  it("rejects malformed UUIDs with 400 instead of 500", async () => {
    const patch = await request(featureApp)
      .patch("/projects/not-a-uuid")
      .send({ name: "x" });
    expect(patch.status).toBe(400);

    const del = await request(featureApp).delete("/projects/not-a-uuid");
    expect(del.status).toBe(400);

    const tasks = await request(featureApp).get("/projects/not-a-uuid/tasks");
    expect(tasks.status).toBe(400);

    const taskPatch = await request(featureApp)
      .patch("/tasks/not-a-uuid")
      .send({ status: "done" });
    expect(taskPatch.status).toBe(400);
  });

  it("rejects impossible calendar dates on tasks with 400", async () => {
    const project = await createProject("Test Project H");
    const res = await request(featureApp)
      .post(`/projects/${project.id}/tasks`)
      .send({ title: "Bad date", dueDate: "2026-02-30" });
    expect(res.status).toBe(400);
  });

  it("maps an invalid assigned-user FK to 400 instead of 500", async () => {
    const project = await createProject("Test Project I");
    const res = await request(featureApp)
      .post(`/projects/${project.id}/tasks`)
      .send({
        title: "Bad assignee",
        assignedUserId: "00000000-0000-0000-0000-000000000000",
      });
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated requests with 401 (admin gating)", async () => {
    const res = await request(app).get("/api/projects");
    expect(res.status).toBe(401);
  });
});
