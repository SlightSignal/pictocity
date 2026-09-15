# GETTING STARTED

## YOUR FIRST AD FORMAT SET

Open a finished demo, make an edit, then let Claude work beside you in the same document. pictocity is free and local; your AI assistant is a separate connection.

### 1. Install and start

Install **Node.js 20 or newer**. Download [pictocity](https://github.com/SlightSignal/pictocity) with **Code → Download ZIP**, extract it, and open the folder containing `package.json`.

On Windows, click File Explorer's address bar, type `cmd`, and press Enter. In that command window, enter these lines separately. Wait for the first two to finish:

```text
npm install
npm run build
npm run server
```

Leave that window running. It serves the editor on your computer at **http://localhost:4100**.

### 2. Open the demo

Open a second command window in the same folder and run:

```text
npm run demo
```

Visit **http://localhost:4100**, open the document picker, and choose the demo. It is the coffee ad shown in the README. Your canvas is in the middle; **Properties**, **Layers**, and **History** are on the right. Double-click the headline to edit it, then click away to commit. Changes save automatically.

### 3. Connect Claude Desktop

Keep pictocity's server running. In Claude Desktop, open **Settings → Developer → Edit Config** ([setup reference](https://modelcontextprotocol.io/quickstart/user)). Add the README's MCP configuration below. This example assumes pictocity is in `C:/pictocity`; replace that folder with yours, keeping forward slashes.

```json
{
  "mcpServers": {
    "pictocity": {
      "command": "node",
      "args": ["C:/pictocity/packages/mcp/dist/index.js"],
      "env": { "PICTOCITY_URL": "http://localhost:4100" }
    }
  }
}
```

If `mcpServers` already contains other tools, add only the `pictocity` entry inside it. Save, fully quit Claude, and reopen it. Ask Claude to list pictocity's documents to confirm the connection, then identify the demo by name. The README also has a registration command for Claude Code.

### 4. Watch a small agent edit

Ask Claude:

> Read this document and its history. Keep my headline edit. Move the call-to-action button and its label slightly upward together. Give the change a clear History label, then render a preview.

Watch the canvas and **History**. Your entries have blue dots; agent entries have orange dots. Both of you are editing the same layers. Click a History entry to return the whole document to that point.

### 5. Protect your finished work

Adjust a layer by hand, then click its **padlock in Layers**. A locked layer cannot be moved, edited, or deleted by you or the agent until you unlock it. Lock any finished artwork you want preserved before requesting the next pass.

### 6. Make and export the set

Give Claude the bundled `skills/ad-campaign/SKILL.md` and ask it to adapt the demo into **feed, story, and square artboards**, preserving locked layers. The workflow builds a master, copies linked layers into each format, and adjusts the layout for each size. Linked text and colors stay in sync; placement and font size can differ.

Ask Claude to run **check_spec** for each artboard's platform, fix errors, and render previews. Review every size yourself.

Choose **File → Export As**, select **PNG**, and set the scope to **each artboard**. Download the files or save them to the server's exports folder; **File → Show exports** lists saved outputs. Use **Save As** to keep a portable `.pictocity` package with the editable document and images.
