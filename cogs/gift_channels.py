"""Gift code channel management — setup, configuration, deletion, and announcing new codes."""

import discord
import sqlite3
import logging

from .pimp_my_bot import theme
from .alliance_member_operations import AllianceSelectView
from .alliance import PaginatedChannelView

logger = logging.getLogger('gift')

REDEEM_HUB_URL = "https://policechief.walgames.com/en/redeemhub"


async def announce_new_code(cog, code, note, expiry_date, added_by):
    """Post an announcement embed for `code` to every alliance's configured gift
    channel. Broadest-reach default: a new code goes out to every configured
    channel, not just the alliance(s) the adding admin manages.

    Returns (posted, total, failed) - failed is [(alliance_id, channel_id), ...]
    for channels that could not be reached/posted to.
    """
    cog.cursor.execute("SELECT alliance_id, channel_id FROM giftcode_channel")
    configs = cog.cursor.fetchall()

    description = f"{theme.giftIcon} **Code:** `{code}`\n"
    if note:
        description += f"{theme.editListIcon} **Note:** {note}\n"
    if expiry_date:
        description += f"{theme.timeIcon} **Expires:** {expiry_date}\n"
    description += (
        f"\nRedeem it yourself at [{REDEEM_HUB_URL}]({REDEEM_HUB_URL})"
    )

    embed = discord.Embed(
        title=f"{theme.giftIcon} New Gift Code!",
        description=description,
        color=theme.emColor3,
    )
    if added_by is not None:
        embed.set_footer(text=f"Added by {added_by.display_name}")

    posted = 0
    failed = []
    for alliance_id, channel_id in configs:
        channel = cog.bot.get_channel(channel_id)
        if not channel:
            failed.append((alliance_id, channel_id))
            continue
        try:
            await channel.send(embed=embed)
            posted += 1
        except Exception as e:
            cog.logger.warning(
                f"GiftChannels: failed to announce code in channel {channel_id} "
                f"(alliance {alliance_id}): {e}"
            )
            failed.append((alliance_id, channel_id))

    return posted, len(configs), failed


async def setup_gift_channel(cog, interaction: discord.Interaction):
    admin_info = await cog.get_admin_info(interaction.user.id)
    if not admin_info:
        await interaction.response.send_message(
            f"{theme.deniedIcon} You are not authorized to perform this action.",
            ephemeral=True
        )
        return

    available_alliances = await cog.get_available_alliances(interaction)
    if not available_alliances:
        await interaction.response.send_message(
            embed=discord.Embed(
                title=f"{theme.deniedIcon} No Available Alliances",
                description="You don't have access to any alliances.",
                color=theme.emColor2
            ),
            ephemeral=True
        )
        return

    alliances_with_counts = []
    for alliance_id, name in available_alliances:
        with sqlite3.connect('db/users.sqlite') as users_db:
            cursor = users_db.cursor()
            cursor.execute("SELECT COUNT(*) FROM users WHERE alliance = ?", (alliance_id,))
            member_count = cursor.fetchone()[0]
            alliances_with_counts.append((alliance_id, name, member_count))

    cog.cursor.execute("SELECT alliance_id, channel_id FROM giftcode_channel")
    current_channels = dict(cog.cursor.fetchall())

    alliance_embed = discord.Embed(
        title=f"{theme.announceIcon} Gift Code Channel Setup",
        description=(
            f"Please select an alliance to set up gift code channel:\n\n"
            f"**Alliance List**\n"
            f"{theme.middleDivider}\n"
            f"Select an alliance from the list below:\n"
        ),
        color=theme.emColor1
    )

    view = AllianceSelectView(alliances_with_counts, cog, context="giftcode")

    async def alliance_callback(select_interaction: discord.Interaction, alliance_id=None):
        try:
            if alliance_id is None:
                alliance_id = int(view.current_select.values[0])

            channel_embed = discord.Embed(
                title=f"{theme.announceIcon} Gift Code Channel Setup",
                description=(
                    "**Instructions:**\n"
                    f"{theme.middleDivider}\n"
                    "Please select a channel for gift codes\n\n"
                    "**Page:** 1/1\n"
                    f"**Total Channels:** {len(select_interaction.guild.text_channels)}"
                ),
                color=theme.emColor1
            )

            async def channel_select_callback(channel_interaction: discord.Interaction):
                try:
                    channel_id = int(channel_interaction.data["values"][0])

                    cog.cursor.execute("""
                        INSERT OR REPLACE INTO giftcode_channel (alliance_id, channel_id)
                        VALUES (?, ?)
                    """, (alliance_id, channel_id))
                    cog.conn.commit()

                    alliance_name = next((name for aid, name in available_alliances if aid == alliance_id), "Unknown Alliance")

                    success_embed = discord.Embed(
                        title=f"{theme.verifiedIcon} Gift Code Channel Set",
                        description=(
                            f"Successfully set gift code channel:\n\n"
                            f"{theme.allianceIcon} **Alliance:** {alliance_name}\n"
                            f"{theme.editListIcon} **Channel:** <#{channel_id}>\n\n"
                            f"{theme.verifiedIcon} New gift codes added via **Add Gift Code** will be "
                            f"announced in this channel."
                        ),
                        color=theme.emColor3
                    )

                    await channel_interaction.response.edit_message(
                        embed=success_embed,
                        view=None
                    )

                except Exception as e:
                    cog.logger.exception(f"Error setting gift code channel: {e}")
                    await channel_interaction.response.send_message(
                        f"{theme.deniedIcon} An error occurred while setting the gift code channel.",
                        ephemeral=True
                    )

            channels = select_interaction.guild.text_channels
            channel_view = PaginatedChannelView(channels, channel_select_callback)

            if not select_interaction.response.is_done():
                await select_interaction.response.edit_message(
                    embed=channel_embed,
                    view=channel_view
                )
            else:
                await select_interaction.message.edit(
                    embed=channel_embed,
                    view=channel_view
                )

        except Exception as e:
            cog.logger.exception(f"Error in alliance selection: {e}")
            if not select_interaction.response.is_done():
                await select_interaction.response.send_message(
                    f"{theme.deniedIcon} An error occurred while processing your selection.",
                    ephemeral=True
                )
            else:
                await select_interaction.followup.send(
                    f"{theme.deniedIcon} An error occurred while processing your selection.",
                    ephemeral=True
                )

    if len(alliances_with_counts) == 1:
        # Only one alliance managed — skip straight to the channel picker.
        await alliance_callback(interaction, alliance_id=alliances_with_counts[0][0])
        return

    view.callback = alliance_callback

    await interaction.response.send_message(
        embed=alliance_embed,
        view=view,
        ephemeral=True
    )


async def delete_gift_channel(cog, interaction: discord.Interaction):
    admin_info = await cog.get_admin_info(interaction.user.id)
    if not admin_info:
        await interaction.response.send_message(
            f"{theme.deniedIcon} You are not authorized to perform this action.",
            ephemeral=True
        )
        return

    available_alliances = await cog.get_available_alliances(interaction)
    if not available_alliances:
        await interaction.response.send_message(
            embed=discord.Embed(
                title=f"{theme.deniedIcon} No Available Alliances",
                description="You don't have access to any alliances.",
                color=theme.emColor2
            ),
            ephemeral=True
        )
        return

    cog.cursor.execute("SELECT alliance_id, channel_id FROM giftcode_channel")
    current_channels = dict(cog.cursor.fetchall())

    alliances_with_counts = []
    for alliance_id, name in available_alliances:
        if alliance_id in current_channels:
            with sqlite3.connect('db/users.sqlite') as users_db:
                cursor = users_db.cursor()
                cursor.execute("SELECT COUNT(*) FROM users WHERE alliance = ?", (alliance_id,))
                member_count = cursor.fetchone()[0]
                alliances_with_counts.append((alliance_id, name, member_count))

    if not alliances_with_counts:
        await interaction.response.send_message(
            embed=discord.Embed(
                title=f"{theme.deniedIcon} No Channels Set",
                description="There are no gift code channels set for your alliances.",
                color=theme.emColor2
            ),
            ephemeral=True
        )
        return

    remove_embed = discord.Embed(
        title=f"{theme.trashIcon} Remove Gift Code Channel",
        description=(
            f"Select an alliance to remove its gift code channel:\n\n"
            f"**Current Log Channels**\n"
            f"{theme.upperDivider}\n"
            f"Select an alliance from the list below:\n"
        ),
        color=theme.emColor2
    )

    view = AllianceSelectView(alliances_with_counts, cog, context="giftcode")

    async def alliance_callback(select_interaction: discord.Interaction, alliance_id=None):
        try:
            if alliance_id is None:
                alliance_id = int(view.current_select.values[0])

            cog.cursor.execute("SELECT channel_id FROM giftcode_channel WHERE alliance_id = ?", (alliance_id,))
            channel_id = cog.cursor.fetchone()[0]

            alliance_name = next((name for aid, name in available_alliances if aid == alliance_id), "Unknown Alliance")

            confirm_embed = discord.Embed(
                title=f"{theme.warnIcon} Confirm Removal",
                description=(
                    f"Are you sure you want to remove the gift code channel for:\n\n"
                    f"{theme.allianceIcon} **Alliance:** {alliance_name}\n"
                    f"{theme.editListIcon} **Channel:** <#{channel_id}>\n\n"
                    "This action cannot be undone!"
                ),
                color=discord.Color.yellow()
            )

            confirm_view = discord.ui.View()

            async def confirm_callback(button_interaction: discord.Interaction):
                try:
                    cog.cursor.execute("DELETE FROM giftcode_channel WHERE alliance_id = ?", (alliance_id,))
                    cog.conn.commit()

                    success_embed = discord.Embed(
                        title=f"{theme.verifiedIcon} Gift Code Channel Removed",
                        description=(
                            f"Successfully removed gift code channel for:\n\n"
                            f"{theme.allianceIcon} **Alliance:** {alliance_name}\n"
                            f"{theme.editListIcon} **Channel:** <#{channel_id}>"
                        ),
                        color=theme.emColor3
                    )

                    await button_interaction.response.edit_message(
                        embed=success_embed,
                        view=None
                    )

                except Exception as e:
                    cog.logger.exception(f"Error removing gift code channel: {e}")
                    await button_interaction.response.send_message(
                        f"{theme.deniedIcon} An error occurred while removing the gift code channel.",
                        ephemeral=True
                    )

            async def cancel_callback(button_interaction: discord.Interaction):
                cancel_embed = discord.Embed(
                    title=f"{theme.deniedIcon} Removal Cancelled",
                    description="The gift code channel removal has been cancelled.",
                    color=theme.emColor2
                )
                await button_interaction.response.edit_message(
                    embed=cancel_embed,
                    view=None
                )

            confirm_button = discord.ui.Button(
                label="Confirm",
                emoji=f"{theme.verifiedIcon}",
                style=discord.ButtonStyle.danger,
                custom_id="confirm_remove"
            )
            confirm_button.callback = confirm_callback

            cancel_button = discord.ui.Button(
                label="Cancel",
                emoji=f"{theme.deniedIcon}",
                style=discord.ButtonStyle.secondary,
                custom_id="cancel_remove"
            )
            cancel_button.callback = cancel_callback

            confirm_view.add_item(confirm_button)
            confirm_view.add_item(cancel_button)

            if not select_interaction.response.is_done():
                await select_interaction.response.edit_message(
                    embed=confirm_embed,
                    view=confirm_view
                )
            else:
                await select_interaction.message.edit(
                    embed=confirm_embed,
                    view=confirm_view
                )

        except Exception as e:
            cog.logger.exception(f"Error in alliance selection: {e}")
            if not select_interaction.response.is_done():
                await select_interaction.response.send_message(
                    f"{theme.deniedIcon} An error occurred while processing your selection.",
                    ephemeral=True
                )
            else:
                await select_interaction.followup.send(
                    f"{theme.deniedIcon} An error occurred while processing your selection.",
                    ephemeral=True
                )

    if len(alliances_with_counts) == 1:
        # Only one alliance has a gift channel configured — skip straight to confirmation.
        await alliance_callback(interaction, alliance_id=alliances_with_counts[0][0])
        return

    view.callback = alliance_callback

    await interaction.response.send_message(
        embed=remove_embed,
        view=view,
        ephemeral=True
    )


async def delete_gift_channel_for_alliance(cog, interaction: discord.Interaction, alliance_id: int):
    """Remove gift code channel setting for a specific alliance"""
    try:
        # Check if channel exists for this alliance
        cog.cursor.execute("SELECT channel_id FROM giftcode_channel WHERE alliance_id = ?", (alliance_id,))
        result = cog.cursor.fetchone()

        if not result:
            await interaction.response.send_message(
                f"{theme.deniedIcon} No gift code channel is set for this alliance.",
                ephemeral=True
            )
            return

        channel_id = result[0]

        # Get alliance name
        available_alliances = await cog.get_available_alliances(interaction)
        alliance_name = next((name for aid, name in available_alliances if aid == alliance_id), "Unknown Alliance")

        # Create confirmation embed
        confirm_embed = discord.Embed(
            title=f"{theme.warnIcon} Confirm Channel Removal",
            description=(
                f"Are you sure you want to remove the gift code channel setting?\n\n"
                f"{theme.allianceIcon} **Alliance:** {alliance_name}\n"
                f"{theme.editListIcon} **Current Channel:** <#{channel_id}>\n\n"
                "This action cannot be undone!"
            ),
            color=discord.Color.yellow()
        )

        # Create confirmation buttons
        confirm_view = discord.ui.View()

        async def confirm_removal(button_interaction: discord.Interaction):
            try:
                cog.cursor.execute("DELETE FROM giftcode_channel WHERE alliance_id = ?", (alliance_id,))
                cog.conn.commit()

                success_embed = discord.Embed(
                    title=f"{theme.verifiedIcon} Channel Setting Removed",
                    description=(
                        f"Successfully removed gift code channel setting:\n\n"
                        f"{theme.allianceIcon} **Alliance:** {alliance_name}\n"
                        f"{theme.editListIcon} **Channel:** <#{channel_id}>\n\n"
                        "You can set a new channel anytime by selecting a channel from the list above."
                    ),
                    color=theme.emColor3
                )

                await button_interaction.response.edit_message(
                    embed=success_embed,
                    view=None
                )

            except Exception as e:
                cog.logger.exception(f"Error removing gift code channel for alliance {alliance_id}: {e}")
                await button_interaction.response.send_message(
                    f"{theme.deniedIcon} An error occurred while removing the channel setting.",
                    ephemeral=True
                )

        async def cancel_removal(button_interaction: discord.Interaction):
            cancel_embed = discord.Embed(
                title=f"{theme.deniedIcon} Removal Cancelled",
                description="The channel setting removal has been cancelled.",
                color=theme.emColor2
            )
            await button_interaction.response.edit_message(
                embed=cancel_embed,
                view=None
            )

        confirm_button = discord.ui.Button(
            label="Remove Setting",
            emoji=f"{theme.trashIcon}",
            style=discord.ButtonStyle.danger
        )
        confirm_button.callback = confirm_removal

        cancel_button = discord.ui.Button(
            label="Cancel",
            emoji=f"{theme.deniedIcon}",
            style=discord.ButtonStyle.secondary
        )
        cancel_button.callback = cancel_removal

        confirm_view.add_item(confirm_button)
        confirm_view.add_item(cancel_button)

        await interaction.response.send_message(
            embed=confirm_embed,
            view=confirm_view,
            ephemeral=True
        )

    except Exception as e:
        cog.logger.exception(f"Error in delete_gift_channel_for_alliance: {e}")
        await interaction.response.send_message(
            f"{theme.deniedIcon} An error occurred while processing the removal request.",
            ephemeral=True
        )


async def manage_channel_settings(cog, interaction: discord.Interaction):
    """Manage gift code channel settings including channel configuration and historical scanning."""
    admin_info = await cog.get_admin_info(interaction.user.id)
    if not admin_info:
        await interaction.response.send_message(
            f"{theme.deniedIcon} You are not authorized to perform this action.",
            ephemeral=True
        )
        return

    available_alliances = await cog.get_available_alliances(interaction)
    if not available_alliances:
        await interaction.response.send_message(
            embed=discord.Embed(
                title=f"{theme.deniedIcon} No Available Alliances",
                description="You don't have access to any alliances.",
                color=theme.emColor2
            ),
            ephemeral=True
        )
        return

    # Get alliances with configured channels
    cog.cursor.execute("""
        SELECT alliance_id, channel_id
        FROM giftcode_channel
        ORDER BY alliance_id
    """)
    channel_configs = cog.cursor.fetchall()

    alliance_names = {aid: name for aid, name in available_alliances}
    main_embed = discord.Embed(
        title=f"{theme.settingsIcon} Channel Management",
        description="Manage gift code channels for your alliances.",
        color=theme.emColor1
    )

    # Show configured channels
    if channel_configs:
        configured_text = ""
        for alliance_id, channel_id in channel_configs:
            if alliance_id in alliance_names:
                alliance_name = alliance_names[alliance_id]
                channel = cog.bot.get_channel(channel_id)
                if channel:
                    channel_name = f"<#{channel_id}>"
                else:
                    channel_name = f"Unknown Channel ({channel_id})"
                configured_text += f"{theme.allianceIcon} **{alliance_name}**\n{theme.announceIcon} Channel: {channel_name}\n\n"

        if configured_text:
            main_embed.add_field(
                name=f"{theme.listIcon} Current Configurations",
                value=configured_text,
                inline=False
            )
    else:
        main_embed.add_field(
            name=f"{theme.listIcon} Current Configurations",
            value="No gift code channels configured yet.",
            inline=False
        )

    main_view = discord.ui.View(timeout=300)

    # Configure/Change Channel button
    config_button = discord.ui.Button(
        label="Configure Channel",
        style=discord.ButtonStyle.primary,
        emoji=f"{theme.announceIcon}"
    )

    async def config_callback(config_interaction: discord.Interaction):
        async def alliance_select_callback(alliance_interaction: discord.Interaction, alliance_id=None):
            if alliance_id is None:
                alliance_id = int(alliance_select.values[0])
            alliance_name = alliance_names[alliance_id]

            channel_embed = discord.Embed(
                title=f"{theme.announceIcon} Configure Channel for {alliance_name}",
                description="Select a channel for gift codes:",
                color=theme.emColor1
            )

            # Using PaginatedChannelView from alliance.py for channel selection

            async def channel_callback(channel_interaction: discord.Interaction):
                try:
                    channel_id = int(channel_interaction.data["values"][0])

                    cog.cursor.execute("""
                        INSERT OR REPLACE INTO giftcode_channel (alliance_id, channel_id)
                        VALUES (?, ?)
                    """, (alliance_id, channel_id))
                    cog.conn.commit()

                    success_embed = discord.Embed(
                        title=f"{theme.verifiedIcon} Channel Configured",
                        description=(
                            f"{theme.allianceIcon} **Alliance:** {alliance_name}\n"
                            f"{theme.announceIcon} **Channel:** <#{channel_id}>\n\n"
                            f"{theme.verifiedIcon} New gift codes will be announced in this channel."
                        ),
                        color=theme.emColor3
                    )

                    await channel_interaction.response.edit_message(
                        embed=success_embed,
                        view=None
                    )

                except Exception as e:
                    cog.logger.exception(f"Error configuring channel: {e}")
                    await channel_interaction.response.send_message(
                        f"{theme.deniedIcon} An error occurred while configuring the channel.",
                        ephemeral=True
                    )

            channel_view = PaginatedChannelView(
                alliance_interaction.guild.text_channels,
                channel_callback
            )

            if not alliance_interaction.response.is_done():
                await alliance_interaction.response.edit_message(
                    embed=channel_embed,
                    view=channel_view
                )
            else:
                await alliance_interaction.message.edit(
                    embed=channel_embed,
                    view=channel_view
                )

        if len(available_alliances) == 1:
            # Only one alliance managed — skip straight to the channel picker.
            await alliance_select_callback(config_interaction, alliance_id=available_alliances[0][0])
            return

        # Show alliance selection for configuration
        alliance_embed = discord.Embed(
            title=f"{theme.announceIcon} Select Alliance to Configure",
            description="Choose an alliance to set up or change its gift code channel:",
            color=theme.emColor1
        )

        alliance_options = []
        for alliance_id, name in available_alliances:
            # Check if already configured
            current_channel_id = None
            for aid, cid in channel_configs:
                if aid == alliance_id:
                    current_channel_id = cid
                    break

            if current_channel_id:
                # Get the actual channel object to display the name
                channel = cog.bot.get_channel(current_channel_id)
                if channel:
                    description = f"Currently: #{channel.name}"
                else:
                    description = f"Currently: Unknown Channel ({current_channel_id})"
            else:
                description = "Not configured"

            alliance_options.append(discord.SelectOption(
                label=name,
                value=str(alliance_id),
                description=description,
                emoji=theme.allianceIcon
            ))

        alliance_select = discord.ui.Select(
            placeholder="Select alliance to configure...",
            options=alliance_options,
            min_values=1,
            max_values=1
        )

        alliance_select.callback = alliance_select_callback
        alliance_view = discord.ui.View(timeout=300)
        alliance_view.add_item(alliance_select)

        await config_interaction.response.edit_message(
            embed=alliance_embed,
            view=alliance_view
        )

    config_button.callback = config_callback
    main_view.add_item(config_button)


    # Remove Channel button (only show if there are configured channels)
    if channel_configs:
        remove_button = discord.ui.Button(
            label="Remove Channel",
            style=discord.ButtonStyle.danger,
            emoji=f"{theme.trashIcon}"
        )

        async def remove_callback(remove_interaction: discord.Interaction):
            async def remove_select_callback(remove_select_interaction: discord.Interaction, alliance_id=None):
                if alliance_id is None:
                    alliance_id = int(remove_select.values[0])
                alliance_name = alliance_names[alliance_id]

                # Get channel info for confirmation
                cog.cursor.execute("SELECT channel_id FROM giftcode_channel WHERE alliance_id = ?", (alliance_id,))
                result = cog.cursor.fetchone()
                if not result:
                    await remove_select_interaction.response.send_message(
                        f"{theme.deniedIcon} Configuration not found.",
                        ephemeral=True
                    )
                    return

                channel_id = result[0]

                # Confirmation embed
                confirm_embed = discord.Embed(
                    title=f"{theme.warnIcon} Confirm Removal",
                    description=(
                        f"Are you sure you want to remove the gift code channel configuration?\n\n"
                        f"{theme.allianceIcon} **Alliance:** {alliance_name}\n"
                        f"{theme.announceIcon} **Channel:** <#{channel_id}>\n\n"
                        f"{theme.warnIcon} **Warning:** This will stop the bot from monitoring this channel for gift codes."
                    ),
                    color=theme.emColor2
                )

                confirm_view = discord.ui.View(timeout=60)

                confirm_button = discord.ui.Button(
                    label="Yes, Remove",
                    style=discord.ButtonStyle.danger,
                    emoji=f"{theme.verifiedIcon}"
                )

                cancel_button = discord.ui.Button(
                    label="Cancel",
                    style=discord.ButtonStyle.secondary,
                    emoji=f"{theme.deniedIcon}"
                )

                async def confirm_remove_callback(confirm_interaction: discord.Interaction):
                    try:
                        cog.cursor.execute("DELETE FROM giftcode_channel WHERE alliance_id = ?", (alliance_id,))
                        cog.conn.commit()

                        success_embed = discord.Embed(
                            title=f"{theme.verifiedIcon} Channel Configuration Removed",
                            description=(
                                f"Successfully removed gift code channel configuration:\n\n"
                                f"{theme.allianceIcon} **Alliance:** {alliance_name}\n"
                                f"{theme.announceIcon} **Channel:** <#{channel_id}>"
                            ),
                            color=theme.emColor3
                        )

                        await confirm_interaction.response.edit_message(
                            embed=success_embed,
                            view=None
                        )

                    except Exception as e:
                        cog.logger.exception(f"Error removing channel configuration: {e}")
                        await confirm_interaction.response.send_message(
                            f"{theme.deniedIcon} Error removing configuration: {str(e)}",
                            ephemeral=True
                        )

                async def cancel_remove_callback(cancel_interaction: discord.Interaction):
                    await manage_channel_settings(cog, cancel_interaction)

                confirm_button.callback = confirm_remove_callback
                cancel_button.callback = cancel_remove_callback
                confirm_view.add_item(confirm_button)
                confirm_view.add_item(cancel_button)

                if not remove_select_interaction.response.is_done():
                    await remove_select_interaction.response.edit_message(
                        embed=confirm_embed,
                        view=confirm_view
                    )
                else:
                    await remove_select_interaction.message.edit(
                        embed=confirm_embed,
                        view=confirm_view
                    )

            # Alliances the admin manages that actually have a channel configured.
            removable_alliances = [
                (alliance_id, alliance_names[alliance_id])
                for alliance_id, _ in channel_configs
                if alliance_id in alliance_names
            ]

            if len(removable_alliances) == 1:
                # Only one alliance has a channel configured — skip straight to confirmation.
                await remove_select_callback(remove_interaction, alliance_id=removable_alliances[0][0])
                return

            # Show alliance selection for removal
            remove_embed = discord.Embed(
                title=f"{theme.trashIcon} Select Alliance to Remove",
                description="Choose an alliance to remove its gift code channel configuration:",
                color=theme.emColor2
            )

            remove_options = [
                discord.SelectOption(
                    label=name,
                    value=str(alliance_id),
                    description=f"Remove channel <#{dict(channel_configs)[alliance_id]}>",
                    emoji=f"{theme.trashIcon}"
                )
                for alliance_id, name in removable_alliances
            ]

            remove_select = discord.ui.Select(
                placeholder="Select alliance to remove channel...",
                options=remove_options,
                min_values=1,
                max_values=1
            )

            remove_select.callback = remove_select_callback
            remove_view = discord.ui.View(timeout=300)
            remove_view.add_item(remove_select)

            await remove_interaction.response.edit_message(
                embed=remove_embed,
                view=remove_view
            )

        remove_button.callback = remove_callback
        main_view.add_item(remove_button)

    await interaction.response.send_message(
        embed=main_embed,
        view=main_view,
        ephemeral=True
    )

