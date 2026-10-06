import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import type { Express, Request, Response } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { Client, Server, utils, type SFTPWrapper } from "ssh2";
import { expect, it, vi } from "vitest";
import { registerFileDownloadRoutes } from "../../src/backend/download-routes.js";
import {
  ChannelOpenSerializer,
  type SSHSession,
} from "../../src/backend/session.js";

const FILE_MODE = 0o100644;

it("keeps the session channel responsive while a cancelled download's close is unanswered", async () => {
  const size = 8 * 1024 * 1024;
  let sftpChannels = 0;
  let closedChannels = 0;
  let unansweredCloses = 0;
  const server = new Server(
    { hostKeys: [utils.generateKeyPairSync("rsa", { bits: 2048 }).private] },
    (client) => {
      client.on("authentication", (ctx) => ctx.accept());
      client.on("ready", () =>
        client.on("session", (accept) => {
          const session = accept();
          session.on("sftp", (acceptSftp) => {
            sftpChannels++;
            const sftp = acceptSftp();
            // Requests are served in order, so an unanswered CLOSE stalls
            // everything after it on the same channel.
            let stalled = false;
            sftp.on("close", () => closedChannels++);
            sftp.on(
              "STAT",
              (id) =>
                stalled ||
                sftp.attrs(id, {
                  mode: FILE_MODE,
                  size,
                  uid: 0,
                  gid: 0,
                  atime: 0,
                  mtime: 0,
                }),
            );
            sftp.on("OPEN", (id) => sftp.handle(id, Buffer.from("file")));
            sftp.on("READ", (id, _handle, offset, length) =>
              setTimeout(
                () =>
                  sftp.data(id, Buffer.alloc(Math.min(length, size - offset))),
                5,
              ),
            );
            // Like a server that reads the rest of the file before answering.
            sftp.on("CLOSE", () => {
              stalled = true;
              unansweredCloses++;
            });
          });
        }),
      );
    },
  );
  const client = new Client();
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    client.connect({
      host: "127.0.0.1",
      port: (server.address() as AddressInfo).port,
      username: "test",
    });
    await once(client, "ready");
    const shared = await new Promise<SFTPWrapper>((resolve, reject) =>
      client.sftp((err, channel) => (err ? reject(err) : resolve(channel))),
    );

    const routes = new Map<
      string,
      (req: Request, res: Response) => Promise<unknown>
    >();
    registerFileDownloadRoutes(
      {
        post: (path, handler) => routes.set(path, handler),
      } as unknown as Express,
      {
        ctx: {
          currentActor: () => "user",
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        } as unknown as PluginContext,
        sshSessions: {
          s: {
            client,
            isConnected: true,
            sftp: shared,
            channelOpener: new ChannelOpenSerializer(),
          } as unknown as SSHSession,
        },
        scheduleSessionCleanup: vi.fn(),
        verifySessionOwnership: () => true,
      },
    );
    const res = Object.assign(new PassThrough(), {
      headersSent: false,
      setHeader: vi.fn(),
      removeHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    });
    await routes.get("/downloadFileStream")!(
      { body: { sessionId: "s", path: "/big.bin" } } as Request,
      res as unknown as Response,
    );
    await once(res, "data");
    res.destroy();
    await vi.waitFor(() => expect(unansweredCloses).toBe(1));
    expect(sftpChannels).toBe(2);

    const answered = new Promise<void>((resolve, reject) =>
      shared.stat("/", (err) => (err ? reject(err) : resolve())),
    );
    await expect(
      Promise.race([
        answered.then(() => "answered"),
        new Promise((resolve) => setTimeout(resolve, 1000, "stalled")),
      ]),
    ).resolves.toBe("answered");

    await vi.waitFor(() => expect(closedChannels).toBe(1), {
      timeout: 5000,
    });
  } finally {
    const closedClient = once(client, "close");
    client.destroy();
    await closedClient;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15000);
