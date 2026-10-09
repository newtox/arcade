//
// doomgeneric platform layer for the browser (WebAssembly, WASI reactor).
// Video, input, sound effects and the arcade hooks talk to the page
// through a handful of imported/exported functions.
//

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "doomgeneric.h"
#include "doomkeys.h"
#include "d_event.h"
#include "d_player.h"
#include "i_sound.h"
#include "w_wad.h"
#include "z_zone.h"
#include "dg_arcade.h"

#define WASM_IMPORT(name) __attribute__((import_module("env"), import_name(#name)))
#define WASM_EXPORT(name) __attribute__((export_name(#name)))

WASM_IMPORT(js_now_ms) double js_now_ms(void);
WASM_IMPORT(js_draw) void js_draw(const uint32_t *pixels, int width, int height);
WASM_IMPORT(js_title) void js_title(const char *title);
WASM_IMPORT(js_sfx_start) int js_sfx_start(int channel, int lump, const uint8_t *data, int length, int vol, int sep);
WASM_IMPORT(js_sfx_update) void js_sfx_update(int channel, int vol, int sep);
WASM_IMPORT(js_sfx_stop) void js_sfx_stop(int channel);
WASM_IMPORT(js_sfx_playing) int js_sfx_playing(int channel);
WASM_IMPORT(js_level_done) void js_level_done(int skill, int episode, int map, int next, int kills, int maxkills,
                                              int items, int maxitems, int secrets, int maxsecrets, int tics, int partics);
WASM_IMPORT(js_new_game) void js_new_game(int skill, int episode);
WASM_IMPORT(js_unranked) void js_unranked(int reason);

// ---------- Timing ----------

static double time_base = 0;     // ms of real time hidden from the game (wipes)
static double wipe_real_start = 0;
static int wipe_active = 0;
static int wipe_last_tic = 0;

void DG_Init(void) {}

void DG_SleepMs(uint32_t ms) { (void) ms; }

uint32_t DG_GetTicksMs(void)
{
    double now = wipe_active ? wipe_real_start : js_now_ms();
    return (uint32_t) (now - time_base);
}

void DG_WipeBegin(void)
{
    wipe_active = 1;
    wipe_real_start = js_now_ms();
    wipe_last_tic = (int) (wipe_real_start * 35 / 1000) - 1;
}

int DG_WipeActive(void) { return wipe_active; }

int DG_WipeTics(void)
{
    int now = (int) (js_now_ms() * 35 / 1000);
    int tics = now - wipe_last_tic;
    if (tics > 0) wipe_last_tic = now;
    return tics;
}

void DG_WipeEnd(void)
{
    // The game was frozen during the melt, like in the DOS version.
    time_base += js_now_ms() - wipe_real_start;
    wipe_active = 0;
}

// ---------- Video ----------

void DG_DrawFrame(void)
{
    js_draw(DG_ScreenBuffer, DOOMGENERIC_RESX, DOOMGENERIC_RESY);
}

void DG_SetWindowTitle(const char *title)
{
    js_title(title);
}

// ---------- Input ----------

#define KEYQUEUE_SIZE 64
static uint32_t key_queue[KEYQUEUE_SIZE];
static unsigned int key_write = 0, key_read = 0;
static int current_char = 0;

// doomkey: game key (may be remapped, e.g. D = strafe right);
// typed: the character the keyboard produced, used for menus and cheats.
WASM_EXPORT(dg_key) void dg_key(int pressed, int doomkey, int typed)
{
    key_queue[key_write] = ((uint32_t) (typed & 0xff) << 16) | ((pressed ? 1u : 0u) << 8) | (doomkey & 0xff);
    key_write = (key_write + 1) % KEYQUEUE_SIZE;
}

int DG_GetKey(int *pressed, unsigned char *key)
{
    if (key_read == key_write) return 0;
    uint32_t data = key_queue[key_read];
    key_read = (key_read + 1) % KEYQUEUE_SIZE;
    *pressed = (data >> 8) & 1;
    *key = data & 0xff;
    current_char = (data >> 16) & 0xff;
    return 1;
}

int DG_TypedChar(void)
{
    return current_char;
}

WASM_EXPORT(dg_mouse) void dg_mouse(int buttons, int dx, int dy)
{
    event_t ev;
    ev.type = ev_mouse;
    ev.data1 = buttons;
    ev.data2 = dx;
    ev.data3 = dy;
    ev.data4 = 0;
    D_PostEvent(&ev);
}

// ---------- Startup / main loop ----------

unsigned int dg_audio_rate = 44100;
int use_libsamplerate = 0;
float libsamplerate_scale = 0.65f;

static char *game_argv[8];

// which: 0 = doom1.wad (shareware), 1 = freedoom1.wad
WASM_EXPORT(dg_start) void dg_start(int which, int audio_rate)
{
    int argc = 0;
    if (audio_rate > 0) dg_audio_rate = (unsigned int) audio_rate;
    game_argv[argc++] = "doom";
    game_argv[argc++] = "-iwad";
    game_argv[argc++] = which == 1 ? "freedoom1.wad" : "doom1.wad";
    game_argv[argc] = NULL;
    doomgeneric_Create(argc, game_argv);
}

WASM_EXPORT(dg_tick) void dg_tick(void)
{
    doomgeneric_Tick();
}

// ---------- Music (OPL emulation, see opl_web.c) ----------

extern void OPL_Web_Render(int16_t *buffer, unsigned int frames);
static int16_t *music_buffer = NULL;
static unsigned int music_buffer_frames = 0;

WASM_EXPORT(dg_music_render) int16_t *dg_music_render(unsigned int frames)
{
    if (frames > music_buffer_frames)
    {
        free(music_buffer);
        music_buffer = malloc(frames * 4);
        music_buffer_frames = frames;
    }
    OPL_Web_Render(music_buffer, frames);
    return music_buffer;
}

// ---------- Sound effects ----------

static boolean use_prefix = true;

static boolean Web_InitSound(boolean _use_sfx_prefix)
{
    use_prefix = _use_sfx_prefix;
    return true;
}

static void Web_ShutdownSound(void) {}

static int Web_GetSfxLumpNum(sfxinfo_t *sfx)
{
    char namebuf[9];
    if (sfx->link != NULL) sfx = sfx->link;
    if (use_prefix) snprintf(namebuf, sizeof(namebuf), "ds%s", sfx->name);
    else snprintf(namebuf, sizeof(namebuf), "%s", sfx->name);
    return W_GetNumForName(namebuf);
}

static void Web_UpdateSound(void) {}

static void Web_UpdateSoundParams(int channel, int vol, int sep)
{
    js_sfx_update(channel, vol, sep);
}

static int Web_StartSound(sfxinfo_t *sfx, int channel, int vol, int sep)
{
    int lump = sfx->lumpnum;
    const uint8_t *data = W_CacheLumpNum(lump, PU_STATIC);
    int length = W_LumpLength(lump);
    int result = js_sfx_start(channel, lump, data, length, vol, sep);
    W_ReleaseLumpNum(lump);
    return result;
}

static void Web_StopSound(int channel)
{
    js_sfx_stop(channel);
}

static boolean Web_SoundIsPlaying(int channel)
{
    return js_sfx_playing(channel) != 0;
}

static void Web_CacheSounds(sfxinfo_t *sounds, int num_sounds) { (void) sounds; (void) num_sounds; }

static snddevice_t sound_web_devices[] =
{
    SNDDEVICE_SB, SNDDEVICE_PAS, SNDDEVICE_GUS, SNDDEVICE_WAVEBLASTER,
    SNDDEVICE_SOUNDCANVAS, SNDDEVICE_AWE32,
};

sound_module_t DG_sound_module =
{
    sound_web_devices,
    sizeof(sound_web_devices) / sizeof(*sound_web_devices),
    Web_InitSound,
    Web_ShutdownSound,
    Web_GetSfxLumpNum,
    Web_UpdateSound,
    Web_UpdateSoundParams,
    Web_StartSound,
    Web_StopSound,
    Web_SoundIsPlaying,
    Web_CacheSounds,
};

// ---------- Arcade hooks ----------

void DG_LevelDone(wbstartstruct_t *wb, int skill, int episode, int map)
{
    wbplayerstruct_t *p = &wb->plyr[wb->pnum];
    js_level_done(skill, episode, map, wb->next + 1, p->skills, wb->maxkills, p->sitems, wb->maxitems,
                  p->ssecret, wb->maxsecret, p->stime, wb->partime);
}

void DG_NewGame(int skill, int episode) { js_new_game(skill, episode); }
void DG_GameLoaded(void) { js_unranked(1); }
void DG_CheatUsed(void) { js_unranked(2); }

// ---------- libc gaps ----------

int system(const char *command)
{
    (void) command;
    return -1;
}

void *I_Realloc(void *ptr, size_t size)
{
    void *result = realloc(ptr, size);
    if (result == NULL && size != 0)
    {
        abort();
    }
    return result;
}

#ifdef DG_TEST
// Test builds only: finish the current level immediately.
extern void G_ExitLevel(void);
WASM_EXPORT(dg_test_exit) void dg_test_exit(void) { G_ExitLevel(); }
#endif
