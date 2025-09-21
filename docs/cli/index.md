# Ionesco CLI

Within Ionesco CLI, `packages/cli` is the frontend for users to send and receive prompts with the configured model provider (Gemini by default) and its associated tools. For a general overview of Ionesco CLI, see the [main documentation page](../index.md).

## Navigating this section

- **[Authentication](./authentication.md):** A guide to setting up authentication with Google's AI services.
- **[Commands](./commands.md):** A reference for Ionesco CLI commands (e.g., `/help`, `/tools`, `/theme`).
- **[Configuration](./configuration.md):** A guide to tailoring Ionesco CLI behavior using configuration files.
- **[Enterprise](./enterprise.md):** A guide to enterprise configuration.
- **[Headless Mode](../headless.md):** A comprehensive guide to using Ionesco CLI programmatically for scripting and automation.
- **[Token Caching](./token-caching.md):** Optimize API costs through token caching.
- **[Themes](./themes.md)**: A guide to customizing the CLI's appearance with different themes.
- **[Tutorials](tutorials.md)**: A tutorial showing how to use Ionesco CLI to automate a development task.
- **[Grok Provider](../providers/grok.md)**: Configure the experimental xAI Grok backend.

## Non-interactive mode

Ionesco CLI can be run in a non-interactive mode, which is useful for scripting and automation. In this mode, you pipe input to the CLI, it executes the command, and then it exits.

The following example pipes a command to Ionesco CLI from your terminal:

```bash
echo "What is fine tuning?" | npm run start -- --prompt-from-stdin
```

You can also use the `--prompt` or `-p` flag:

```bash
npm run start -- --prompt "What is fine tuning?"
```

> If you created the optional alias via `./scripts/create_alias.sh`, you can continue to run `gemini -p ...` instead of forwarding flags through `npm run start`.

For comprehensive documentation on headless usage, scripting, automation, and advanced examples, see the **[Headless Mode](../headless.md)** guide.
