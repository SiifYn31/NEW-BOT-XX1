// professional-logger.js
const { Client, GatewayIntentBits, EmbedBuilder, Events } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildBans,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildInvites
  ],
  // partials can help for some events if needed:
  partials: ['CHANNEL', 'GUILD_MEMBER']
});

// ---------- CONFIG: put your real IDs/tokens here ----------
const logChannels = {
  kick: '1424616877937655808',
  ban: '1424617005771784232',
  unban: '1424617029020811325',
  timeout: '1424617241831280761',
  left: '1424616906169782312',
  channelCreate: '1424617297796136970',
  channelUpdate: '1424617329358147616',
  channelDelete: '1424617357032292372',
  channelPinsUpdate: '1424617413470715934',
  roleCreate: '1424617948638744726',
  roleDelete: '1424617972638683166',
  roleRemove: '1424618028078862418',
  roleUpdate: '1424618063545892885',
  roleGive: '1424618107837874238',
  voiceDisconnect: '1424618192990638232',
  voiceMove: '1424618285999198318',
  voiceJoin: '1424618322846027808',
  botAdd: '1424618430530719794',
  botRemove: '1424623663550038026',
  inviteMembers: '1424638429739876443'
};

const backupLogChannel = '1424689664920391743'; // <-- set this

// ---------- Helpers ----------
async function sendLog(channelId, embed) {
  try {
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (ch && ch.send) {
      await ch.send({ embeds: [embed] });
    } else {
      // fallback to backup
      const backup = await client.channels.fetch(backupLogChannel).catch(() => null);
      if (backup && backup.send) await backup.send({ embeds: [embed] }).catch(console.error);
    }
  } catch (err) {
    console.error('sendLog error:', err);
    const backup = await client.channels.fetch(backupLogChannel).catch(() => null);
    if (backup && backup.send) backup.send({ embeds: [embed] }).catch(console.error);
  }
}

function createEmbed({ title, description, color = '#2f3136', executor, target, fields = [], icon = '' }) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${icon} ${title}`)
    .setDescription(description?.slice(0, 4096) || '')
    .setTimestamp();

  if (target?.avatar) embed.setThumbnail(target.avatar);

  if (executor) embed.addFields({ name: '👤 Executor', value: `${executor.name} (\`${executor.id}\`)`, inline: true });
  if (target) embed.addFields({ name: '🎯 Target', value: `${target.name} (\`${target.id}\`)`, inline: true });

  for (const f of fields) embed.addFields(f);

  return embed;
}

// ---------- Robust fetchExecutor with retries and role-action matching ----------
/**
 * type: audit log type string (discord.js accepts both enums and strings)
 * opts: { roleId, action } action = 'ADD'|'REMOVE' for role changes to narrow match
 */
async function fetchExecutorWithSmartMatch(guild, type, targetId, opts = {}) {
  // try several times with small waits to let audit log populate
  const maxAttempts = 4;
  const wait = ms => new Promise(r => setTimeout(r, ms));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const logs = await guild.fetchAuditLogs({ type, limit: 10 }).catch(() => null);
      if (logs && logs.entries) {
        // try to find the best entry:
        // 1) exact target match + (for roles) a change containing the role id and correct $add/$remove
        // 2) exact target match
        // 3) fallback: any recent entry with change that mentions role id
        const entries = Array.from(logs.entries.values()).sort((a, b) => b.createdTimestamp - a.createdTimestamp);

        // specialized match for role add/remove if opts provided
        if (opts.roleId && (opts.action === 'ADD' || opts.action === 'REMOVE')) {
          const key = opts.action === 'ADD' ? '$add' : '$remove';
          const found = entries.find(e =>
            e.target?.id === targetId &&
            Array.isArray(e.changes) &&
            e.changes.some(c =>
              c.key === key && Array.isArray(c.new) && c.new.some(r => r.id === opts.roleId)
            )
          );
          if (found) return { name: found.executor.tag, id: found.executor.id };
          // looser: any entry where changes contain roleId
          const looser = entries.find(e =>
            Array.isArray(e.changes) &&
            e.changes.some(c => Array.isArray(c.new) && c.new.some(r => r.id === opts.roleId))
          );
          if (looser) return { name: looser.executor.tag, id: looser.executor.id };
        }

        // general exact match
        const exact = entries.find(e => e.target?.id === targetId);
        if (exact) return { name: exact.executor.tag, id: exact.executor.id };

        // fallback: most recent entry
        if (entries.length > 0) {
          const recent = entries[0];
          // if recent is within last few seconds it's likely related
          if (Date.now() - recent.createdTimestamp < 10_000) {
            return { name: recent.executor.tag, id: recent.executor.id };
          }
        }
      }
    } catch (err) {
      // ignore and retry
      console.error('fetchExecutorWithSmartMatch attempt error:', err?.message || err);
    }

    // wait before retry
    await wait(1200 + attempt * 300);
  }

  // final fallback
  return { name: 'System/Unknown', id: 'N/A' };
}

// ---------- Role-cache (best-effort) ----------
// Tracks last-known role-sets for members while bot is online.
// If bot restarts you lose the cache (could persist to DB if needed).
const roleCache = new Map(); // key = `${guildId}-${userId}`, value = Set(roleIds)

// helper to set initial cache for a member
function cacheMemberRoles(member) {
  try {
    const key = `${member.guild.id}-${member.id}`;
    roleCache.set(key, new Set(member.roles.cache.map(r => r.id)));
  } catch {}
}

// initialize caches on ready for all members the bot has cached
client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot online as ${client.user.tag} — building role cache...`);
  // iterate guilds and cached members (this is best-effort; avoid large fetches)
  for (const guild of client.guilds.cache.values()) {
    try {
      // fetch members up to cache limits (avoid huge guild fetches automatically)
      await guild.members.fetch().catch(() => null);
      guild.members.cache.forEach(m => cacheMemberRoles(m));
    } catch (err) {
      console.error('Error populating cache for guild', guild.id, err);
    }
  }
  console.log('✅ Role cache ready for cached members.');
});

// Keep cache up to date when members join or role changes detected
client.on(Events.GuildMemberAdd, member => cacheMemberRoles(member));
client.on(Events.GuildMemberRemove, member => roleCache.delete(`${member.guild.id}-${member.id}`));

// ---------- EVENT HANDLERS (full list) ----------

// --- Member Remove (kick vs left)
client.on(Events.GuildMemberRemove, async member => {
  const executor = await fetchExecutorWithSmartMatch(member.guild, 'MEMBER_KICK', member.id);
  const embed = createEmbed({
    title: executor.id !== 'N/A' ? 'Member Kicked' : 'Member Left',
    description: executor.id !== 'N/A' ? `**${member.user.tag}** was kicked.` : `**${member.user.tag}** left the server.`,
    color: executor.id !== 'N/A' ? '#E74C3C' : '#808080',
    executor,
    target: { name: member.user.tag, id: member.id, avatar: member.user.displayAvatarURL?.({ dynamic: true }) },
    icon: executor.id !== 'N/A' ? '🚪' : '👋'
  });
  await sendLog(executor.id !== 'N/A' ? logChannels.kick : logChannels.left, embed);
  // clean roleCache
  roleCache.delete(`${member.guild.id}-${member.id}`);
});

// --- Member Add (bot add detection)
client.on(Events.GuildMemberAdd, async member => {
  cacheMemberRoles(member);
  if (member.user.bot) {
    const embed = createEmbed({
      title: 'Bot Added',
      description: `Bot **${member.user.tag}** joined the server.`,
      color: '#7289DA',
      executor: { name: 'System', id: 'N/A' },
      target: { name: member.user.tag, id: member.id, avatar: member.user.displayAvatarURL?.({ dynamic: true }) },
      icon: '🤖'
    });
    await sendLog(logChannels.botAdd, embed);
  }
});

// --- Member Update: timeout + roles (smart)
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guild = newMember.guild;
  const key = `${guild.id}-${newMember.id}`;

  // --- TIMEOUT changes
  const oldTimeout = oldMember.communicationDisabledUntilTimestamp || 0;
  const newTimeout = newMember.communicationDisabledUntilTimestamp || 0;
  if (oldTimeout !== newTimeout) {
    const executor = await fetchExecutorWithSmartMatch(guild, 'MEMBER_UPDATE', newMember.id);
    const embed = createEmbed({
      title: 'Member Timeout',
      description: `**${newMember.user.tag}** timeout changed.`,
      color: '#FFA500',
      executor,
      target: { name: newMember.user.tag, id: newMember.id, avatar: newMember.user.displayAvatarURL?.({ dynamic: true }) },
      fields: [
        { name: 'Old Timeout', value: oldTimeout ? `<t:${Math.floor(oldTimeout / 1000)}:R>` : 'None', inline: true },
        { name: 'New Timeout', value: newTimeout ? `<t:${Math.floor(newTimeout / 1000)}:R>` : 'None', inline: true }
      ],
      icon: '🔇'
    });
    await sendLog(logChannels.timeout, embed);
  }

  // --- ROLES: we use cache + audit log smart matching
  // Ensure cache exists (if not, initialize from oldMember roles)
  if (!roleCache.has(key)) roleCache.set(key, new Set(oldMember.roles.cache.map(r => r.id)));
  const cached = roleCache.get(key) || new Set();
  const current = new Set(newMember.roles.cache.map(r => r.id));

  // removed roles = present in cached but not in current
  for (const roleId of Array.from(cached)) {
    if (!current.has(roleId)) {
      // try audit logs with role match
      const executor = await fetchExecutorWithSmartMatch(guild, 'MEMBER_ROLE_UPDATE', newMember.id, { roleId, action: 'REMOVE' });
      // fallback: if audit logs unknown, try to infer: who was modifying? use most recent audit executor or fallback to System/Unknown
      const role = guild.roles.cache.get(roleId);
      const embed = createEmbed({
        title: 'Role Removed',
        description: `Role **${role ? role.name : roleId}** removed from **${newMember.user.tag}**.`,
        color: '#E67E22',
        executor,
        target: { name: newMember.user.tag, id: newMember.id },
        fields: [{ name: 'Role ID', value: roleId, inline: true }],
        icon: '➖'
      });
      await sendLog(logChannels.roleRemove, embed);
      cached.delete(roleId); // update cache
    }
  }

  // added roles = present in current but not in cached
  for (const roleId of Array.from(current)) {
    if (!cached.has(roleId)) {
      const executor = await fetchExecutorWithSmartMatch(guild, 'MEMBER_ROLE_UPDATE', newMember.id, { roleId, action: 'ADD' });
      const role = guild.roles.cache.get(roleId);
      const embed = createEmbed({
        title: 'Role Added',
        description: `Role **${role ? role.name : roleId}** added to **${newMember.user.tag}**.`,
        color: '#2ECC71',
        executor,
        target: { name: newMember.user.tag, id: newMember.id },
        fields: [{ name: 'Role ID', value: roleId, inline: true }],
        icon: '➕'
      });
      await sendLog(logChannels.roleGive, embed);
      cached.add(roleId); // update cache
    }
  }

  roleCache.set(key, cached);
});

// --- Bans / Unbans
client.on(Events.GuildBanAdd, async ban => {
  const executor = await fetchExecutorWithSmartMatch(ban.guild, 'MEMBER_BAN_ADD', ban.user.id);
  const embed = createEmbed({
    title: 'Member Banned',
    description: `**${ban.user.tag}** was banned.`,
    color: '#FF0000',
    executor,
    target: { name: ban.user.tag, id: ban.user.id, avatar: ban.user.displayAvatarURL?.({ dynamic: true }) },
    icon: '⛔'
  });
  await sendLog(logChannels.ban, embed);
});

client.on(Events.GuildBanRemove, async ban => {
  const executor = await fetchExecutorWithSmartMatch(ban.guild, 'MEMBER_BAN_REMOVE', ban.user.id);
  const embed = createEmbed({
    title: 'Member Unbanned',
    description: `**${ban.user.tag}** was unbanned.`,
    color: '#00FF00',
    executor,
    target: { name: ban.user.tag, id: ban.user.id, avatar: ban.user.displayAvatarURL?.({ dynamic: true }) },
    icon: '✅'
  });
  await sendLog(logChannels.unban, embed);
});

// --- Channels create/update/delete/pins
client.on(Events.ChannelCreate, async channel => {
  const executor = await fetchExecutorWithSmartMatch(channel.guild, 'CHANNEL_CREATE', channel.id);
  const embed = createEmbed({
    title: 'Channel Created',
    description: `Channel **${channel.name}** created.`,
    color: '#3498DB',
    executor,
    target: { name: channel.name, id: channel.id },
    icon: '📢'
  });
  await sendLog(logChannels.channelCreate, embed);
});

client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
  const executor = await fetchExecutorWithSmartMatch(newChannel.guild, 'CHANNEL_UPDATE', newChannel.id);
  const embed = createEmbed({
    title: 'Channel Updated',
    description: `Channel updated.`,
    color: '#2980B9',
    executor,
    target: { name: newChannel.name, id: newChannel.id },
    fields: [
      { name: 'Old Name', value: oldChannel.name ?? 'N/A', inline: true },
      { name: 'New Name', value: newChannel.name ?? 'N/A', inline: true }
    ],
    icon: '✏️'
  });
  await sendLog(logChannels.channelUpdate, embed);
});

client.on(Events.ChannelDelete, async channel => {
  const executor = await fetchExecutorWithSmartMatch(channel.guild, 'CHANNEL_DELETE', channel.id);
  const embed = createEmbed({
    title: 'Channel Deleted',
    description: `Channel **${channel.name}** deleted.`,
    color: '#E74C3C',
    executor,
    target: { name: channel.name, id: channel.id },
    icon: '🗑️'
  });
  await sendLog(logChannels.channelDelete, embed);
});

client.on(Events.ChannelPinsUpdate, async (channel, time) => {
  // Pins updates rarely have a target; use recent audit logs or system fallback
  const executor = await fetchExecutorWithSmartMatch(channel.guild, 'CHANNEL_PINNED_MESSAGE_UPDATE', channel.id);
  const embed = createEmbed({
    title: 'Channel Pins Updated',
    description: `Pins updated in **${channel.name}**.`,
    color: '#9B59B6',
    executor,
    target: { name: channel.name, id: channel.id },
    icon: '📌'
  });
  await sendLog(logChannels.channelPinsUpdate, embed);
});

// --- Role create/delete/update
client.on(Events.GuildRoleCreate, async role => {
  const executor = await fetchExecutorWithSmartMatch(role.guild, 'ROLE_CREATE', role.id);
  const embed = createEmbed({
    title: 'Role Created',
    description: `Role **${role.name}** created.`,
    color: '#2ECC71',
    executor,
    target: { name: role.name, id: role.id },
    icon: '🆕'
  });
  await sendLog(logChannels.roleCreate, embed);
});

client.on(Events.GuildRoleDelete, async role => {
  const executor = await fetchExecutorWithSmartMatch(role.guild, 'ROLE_DELETE', role.id);
  const embed = createEmbed({
    title: 'Role Deleted',
    description: `Role **${role.name}** deleted.`,
    color: '#E74C3C',
    executor,
    target: { name: role.name, id: role.id },
    icon: '🗑️'
  });
  await sendLog(logChannels.roleDelete, embed);
});

client.on(Events.GuildRoleUpdate, async (oldRole, newRole) => {
  const executor = await fetchExecutorWithSmartMatch(newRole.guild, 'ROLE_UPDATE', newRole.id);
  const embed = createEmbed({
    title: 'Role Updated',
    description: `Role updated: **${oldRole.name}** → **${newRole.name}**.`,
    color: '#27AE60',
    executor,
    target: { name: newRole.name, id: newRole.id },
    fields: [
      { name: 'Old Name', value: oldRole.name ?? 'N/A', inline: true },
      { name: 'New Name', value: newRole.name ?? 'N/A', inline: true }
    ],
    icon: '✏️'
  });
  await sendLog(logChannels.roleUpdate, embed);
});

// --- Voice events
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  // Join
  if (!oldState.channel && newState.channel) {
    const embed = createEmbed({
      title: 'Member Joined Voice',
      description: `**${newState.member?.user?.tag}** joined **${newState.channel.name}**.`,
      color: '#3498DB',
      executor: { name: 'System', id: 'N/A' },
      target: { name: newState.member?.user?.tag ?? 'Unknown', id: newState.member?.id ?? 'N/A' },
      icon: '🎤'
    });
    await sendLog(logChannels.voiceJoin, embed);
  }

  // Left
  if (oldState.channel && !newState.channel) {
    const embed = createEmbed({
      title: 'Member Left Voice',
      description: `**${oldState.member?.user?.tag}** left **${oldState.channel.name}**.`,
      color: '#E74C3C',
      executor: { name: 'System', id: 'N/A' },
      target: { name: oldState.member?.user?.tag ?? 'Unknown', id: oldState.member?.id ?? 'N/A' },
      icon: '🔇'
    });
    await sendLog(logChannels.voiceDisconnect, embed);
  }

  // Move
  if (oldState.channel && newState.channel && oldState.channel.id !== newState.channel.id) {
    const embed = createEmbed({
      title: 'Member Moved Voice',
      description: `**${newState.member?.user?.tag}** moved from **${oldState.channel.name}** to **${newState.channel.name}**.`,
      color: '#F39C12',
      executor: { name: 'System', id: 'N/A' },
      target: { name: newState.member?.user?.tag ?? 'Unknown', id: newState.member?.id ?? 'N/A' },
      icon: '🔄'
    });
    await sendLog(logChannels.voiceMove, embed);
  }
});

// --- Bot add/remove (when a bot account is added/removed)
client.on(Events.GuildMemberAdd, async member => {
  if (member.user.bot) {
    const embed = createEmbed({
      title: 'Bot Added',
      description: `Bot **${member.user.tag}** added to server.`,
      color: '#7289DA',
      executor: { name: 'System', id: 'N/A' },
      target: { name: member.user.tag, id: member.id, avatar: member.user.displayAvatarURL?.({ dynamic: true }) },
      icon: '🤖'
    });
    await sendLog(logChannels.botAdd, embed);
  }
});
client.on(Events.GuildMemberRemove, async member => {
  if (member.user.bot) {
    const embed = createEmbed({
      title: 'Bot Removed',
      description: `Bot **${member.user.tag}** removed from server.`,
      color: '#E74C3C',
      executor: { name: 'System', id: 'N/A' },
      target: { name: member.user.tag, id: member.id, avatar: member.user.displayAvatarURL?.({ dynamic: true }) },
      icon: '👋'
    });
    await sendLog(logChannels.botRemove, embed);
  }
});

// --- Invites
client.on(Events.InviteCreate, async invite => {
  // invite.inviter exists when available
  const executor = invite.inviter ? { name: invite.inviter.tag, id: invite.inviter.id } : await fetchExecutorWithSmartMatch(invite.guild, 'INVITE_CREATE', invite.code);
  const embed = createEmbed({
    title: 'Invite Created',
    description: `Invite **${invite.code}** created.`,
    color: '#8E44AD',
    executor,
    target: { name: invite.guild?.name ?? 'Guild', id: invite.guild?.id ?? 'N/A' },
    icon: '✉️'
  });
  await sendLog(logChannels.inviteMembers, embed);
});

const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require("@discordjs/voice");

// ID ديال السيرفر والقناة الصوتية
const GUILD_ID = "1370559435067363329"; // هنا حط ID السيرفر
const VOICE_CHANNEL_ID = "1420741232270901339"; // هنا حط ID القناة الصوتية

client.once("ready", async () => {
  console.log(`${client.user.tag} هو متصل الآن`);

  try {
    // نلقاو السيرفر
    const guild = await client.guilds.fetch(GUILD_ID);
    if (!guild) return console.log("السيرفر ما لقاوش");

    // نلقاو القناة الصوتية
    const channel = guild.channels.cache.get(VOICE_CHANNEL_ID);
    if (!channel) return console.log("القناة الصوتية ما لقاوهاش");

    // ندخلو للقناة
    const connection = joinVoiceChannel({
      channelId: VOICE_CHANNEL_ID,
      guildId: GUILD_ID,
      adapterCreator: guild.voiceAdapterCreator,
    });

    // نتأكدو باللي البوت متصل
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    console.log(`البوت دخل للقناة الصوتية: ${channel.name}`);
  } catch (err) {
    console.error("خطأ فالدخول للقناة الصوتية:", err);
  }
});


// ---------- LOGIN ----------
client.login('MTQyNDU5NjU2NzAyOTE4NjY1MQ.GhmSDr.Z1AH9rkuaFHKtyew1d0Dj348En8Vn68G5xm8Jk');
