FROM node:22-bookworm

# System dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    wget \
    ca-certificates \
    gnupg \
  && rm -rf /var/lib/apt/lists/*

# .NET SDK 9 (Microsoft package feed for Debian 12 / Bookworm)
RUN wget -qO /tmp/ms.deb https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb \
  && dpkg -i /tmp/ms.deb \
  && rm /tmp/ms.deb \
  && apt-get update \
  && apt-get install -y dotnet-sdk-10.0 \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update \
  && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Rename the base image's "node" user (UID 1000) to "agent".
# Keeps UID 1000 so --user 1000:1000 maps to the right home dir owner.
RUN usermod -d /home/agent -m -l agent node
USER agent

# Bind-mounted host workspace may show foreign UID inside container.
# Tell git to trust any path so `git ...` works against the mount.
RUN git config --global --add safe.directory '*'

# Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

ENV PATH="/home/agent/.local/bin:$PATH" \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1

# main.ts bind-mounts the host workspace at /home/agent/workspace.
WORKDIR /home/agent/workspace

# Reset ENTRYPOINT so the orchestrator can pass a full `claude ...` argv.
ENTRYPOINT []
CMD ["claude"]
