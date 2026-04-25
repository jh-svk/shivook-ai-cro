import type { LoaderFunctionArgs } from "react-router";

export const loader = (_: LoaderFunctionArgs) =>
  new Response("ok", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
