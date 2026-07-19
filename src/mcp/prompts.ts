import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPrompts(server: McpServer): void {
  server.prompt(
    "create_lower_third",
    "Build a simple lower-third (bar + title + subtitle) with fades",
    {
      comp_name: z.string().optional().default("Lower Third"),
      title: z.string().describe("Main title text"),
      subtitle: z.string().optional().default(""),
      brand_color: z
        .string()
        .optional()
        .default("0.1,0.4,0.9")
        .describe("RGB 0-1 comma-separated"),
      duration: z.string().optional().default("5"),
    },
    async ({ comp_name, title, subtitle, brand_color, duration }) => {
      const rgb = brand_color.split(",").map((s) => Number(s.trim()));
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Create a lower-third motion graphic in After Effects using ae-mcp tools.

Specs:
- Comp name: ${comp_name}
- Duration: ${duration}s, 1920x1080, 30fps
- Title: "${title}"
- Subtitle: "${subtitle}"
- Brand bar color RGB: [${rgb.join(", ")}]

Workflow:
1. ae_health — ensure connected
2. ae_create_composition
3. ae_create_layer type=solid for bar (position lower-left area, not full frame — set scale/position)
4. ae_create_layer type=text for title and subtitle
5. Parent text to bar if useful (parent_name)
6. ae_set_keyframes on Opacity for fade in (0→100 over 0.5s) and fade out near end
7. ae_capture_frame at mid-duration to verify
8. Report layer names and any issues

Colors are 0–1 floats. Opacity is 0–100. Prefer layer_name in later calls.`,
            },
          },
        ],
      };
    },
  );

  server.prompt(
    "kinetic_type_intro",
    "Create a kinetic type intro card",
    {
      headline: z.string(),
      duration: z.string().optional().default("4"),
      style: z.string().optional().default("clean").describe("clean|bold|glitch"),
    },
    async ({ headline, duration, style }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Create a kinetic type intro in After Effects via ae-mcp.

Headline: "${headline}"
Duration: ${duration}s
Style: ${style}

Steps:
1. ae_health
2. Create 1920x1080 comp
3. Centered text layer with large fontSize (~120)
4. Animate Position or Scale + Opacity with ae_set_keyframes (ease-like stepped keys)
5. Optional: ae_set_expression wiggle for style=glitch on position
6. ae_capture_frame mid-comp
7. Summarize what you built`,
          },
        },
      ],
    }),
  );

  server.prompt(
    "debug_comp",
    "Inspect the active or named composition and capture a frame",
    {
      comp_name: z.string().optional().describe("Optional comp name; else active"),
    },
    async ({ comp_name }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Debug the After Effects composition${comp_name ? ` "${comp_name}"` : " (active)"}.

1. ae_health
2. ae_get_composition (detailed) ${comp_name ? `comp_name=${comp_name}` : ""}
3. For any suspicious layers, ae_get_layer + ae_list_effects
4. ae_capture_frame
5. Summarize structure, timing issues, missing effects, and suggested fixes`,
          },
        },
      ],
    }),
  );
}
