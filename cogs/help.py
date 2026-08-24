"""/help -- a single, no-permission-required entry point for brand-new
members: how to link their in-game ID (/register) and find the handful of
other member-facing commands. Everything else in this bot (channel setup,
themes, permissions) is admin-configured through /settings, so this stays
short rather than trying to document the whole bot."""
import discord
from discord.ext import commands
from discord import app_commands
from .pimp_my_bot import theme


class Help(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    @app_commands.command(
        name="help",
        description="New here? Learn how to link your in-game ID and get started.",
    )
    async def help(self, interaction: discord.Interaction):
        embed = discord.Embed(
            title=f"{theme.questionIcon} Getting Started",
            description=(
                "This bot tracks alliance activity -- Vault Trap, Capitol War, gift codes, "
                "and more -- tied to your in-game ID. Here's how to get set up."
            ),
            color=theme.emColor1,
        )
        embed.add_field(
            name=f"{theme.linkIcon} Link your in-game ID",
            value=(
                "`/register id:<your in-game ID> alliance:<pick from the list> "
                "name:<your in-game name>`\n"
                "Start typing your alliance's name and pick it from the suggestions that pop up. "
                "`name` is your in-game name specifically -- your Discord name often doesn't match "
                "it, and the bot needs your real in-game name to match you up in screenshots. Two "
                "optional extras: `state` (only needed if your alliance spans several states) and "
                "`level` for your Chief's Office level.\n"
                "Already registered elsewhere? Running `/register` again lets you move your "
                "registration to this server, or update your name/level if you're already linked "
                "here."
            ),
            inline=False,
        )
        embed.add_field(
            name=f"{theme.trashIcon} Unlink an ID",
            value=(
                "`/unregister id:<pick from your linked IDs>` -- only removes IDs linked to "
                "your own Discord account."
            ),
            inline=False,
        )
        embed.add_field(
            name=f"{theme.chartIcon} Check your stats",
            value=(
                "If your alliance has these enabled:\n"
                "`/vault_player_history` and `/capitol_player_history` -- your own damage/points "
                "history\n"
                "`/vault_compare` and `/capitol_compare` -- compare yourself against other members"
            ),
            inline=False,
        )
        embed.add_field(
            name=f"{theme.infoIcon} Something not working?",
            value=(
                "**\"ID already registered\"** -- someone else claimed it first; ask an alliance "
                "admin to sort it out.\n"
                "**\"Registration is currently disabled\"** -- an admin turned it off "
                "temporarily.\n"
                "Anything else (channel setup, permissions, themes) is configured by an alliance "
                "admin through `/settings`."
            ),
            inline=False,
        )
        embed.set_footer(text="Run /help any time you need a refresher.")
        await interaction.response.send_message(embed=embed, ephemeral=True)


async def setup(bot):
    await bot.add_cog(Help(bot))
