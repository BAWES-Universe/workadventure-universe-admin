/**
 * Discord Webhook Utilities
 * Sends notifications to Discord webhook when configured
 */

interface DiscordWebhookEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
  timestamp?: string;
  footer?: {
    text: string;
  };
}

interface DiscordWebhookPayload {
  username?: string;
  avatar_url?: string;
  embeds?: DiscordWebhookEmbed[];
  content?: string;
}

/**
 * Sends a Discord webhook message
 * @param payload The webhook payload
 * @returns Promise<boolean> - true if successful, false otherwise
 */
export async function sendDiscordWebhook(
  payload: DiscordWebhookPayload
): Promise<boolean> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  
  if (!webhookUrl) {
    // Webhook not configured, silently skip
    return false;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error('Discord webhook failed:', response.status, response.statusText);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error sending Discord webhook:', error);
    return false;
  }
}

/**
 * Sends a room access notification to Discord
 */
export async function notifyRoomAccess(data: {
  userName: string | null;
  userEmail: string | null;
  userUuid: string;
  isGuest: boolean;
  playUri: string;
  universe: string;
  world: string;
  room: string;
  ipAddress: string;
}): Promise<void> {
  const statusColor = data.isGuest ? 0xffaa00 : 0x00ff00; // Orange for guests, Green for authenticated
  const statusText = data.isGuest ? 'Guest' : 'Authenticated';
  
  const embed: DiscordWebhookEmbed = {
    title: '🚪 Room Access',
    description: `${data.userName || 'Unknown User'} accessed a room`,
    color: statusColor,
    fields: [
      {
        name: 'User',
        value: data.userName || data.userEmail || 'N/A',
        inline: true,
      },
      {
        name: 'Status',
        value: statusText,
        inline: true,
      },
      {
        name: 'UUID',
        value: `\`${data.userUuid}\``,
        inline: false,
      },
      {
        name: 'Universe',
        value: data.universe,
        inline: true,
      },
      {
        name: 'World',
        value: data.world,
        inline: true,
      },
      {
        name: 'Room',
        value: data.room,
        inline: true,
      },
      {
        name: 'Play URI',
        value: `[View](${data.playUri})`,
        inline: false,
      },
      {
        name: 'IP Address',
        value: `\`${data.ipAddress}\``,
        inline: true,
      },
    ],
    timestamp: new Date().toISOString(),
    footer: {
      text: 'WorkAdventure Admin API',
    },
  };

  await sendDiscordWebhook({
    embeds: [embed],
  });
}

