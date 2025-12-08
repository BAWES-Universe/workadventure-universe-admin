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
  tags?: string[];
  playUri: string;
  universe: string;
  world: string;
  room: string;
  ipAddress: string;
}): Promise<void> {
  // Determine status text based on tags or guest status
  // Prioritize tags over guest status - if user has membership tags, show those
  let statusText: string;
  let statusColor: number;
  
  if (data.tags && data.tags.length > 0) {
    // Show member tags (e.g., "admin", "admin, editor")
    // User has membership, so show tags regardless of guest status
    statusText = data.tags.join(', ');
    statusColor = data.tags.includes('admin') ? 0x00ff00 : 0x0099ff; // Green for admin, Blue for others
  } else if (data.isGuest) {
    // No tags and is guest
    statusText = 'Guest';
    statusColor = 0xffaa00; // Orange for guests
  } else {
    // Authenticated but no tags
    statusText = 'Authenticated';
    statusColor = 0x00ff00; // Green for authenticated
  }
  
  // Use fallback chain: userName > userEmail > userUuid > 'Guest'
  const displayName = data.userName || data.userEmail || data.userUuid || 'Guest';
  
  const embed: DiscordWebhookEmbed = {
    title: '🚪 Room Access',
    description: `${displayName} accessed a room`,
    color: statusColor,
    fields: [
      {
        name: 'User',
        value: displayName,
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
      text: 'Universe Admin',
    },
  };

  await sendDiscordWebhook({
    embeds: [embed],
  });
}

