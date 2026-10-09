//
// OPL backend for the single-threaded WebAssembly build.
// Based on opl_sdl.c from Chocolate Doom (GPL-2.0-or-later).
// The page pulls samples via OPL_Web_Render() from its audio callback.
//

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "opl3.h"
#include "opl.h"
#include "opl_internal.h"
#include "opl_queue.h"

typedef struct
{
    unsigned int rate;
    unsigned int enabled;
    unsigned int value;
    uint64_t expire_time;
} opl_timer_t;

static opl_callback_queue_t *callback_queue;
static uint64_t current_time;
static int paused;
static uint64_t pause_offset;
static opl3_chip opl_chip;
static int register_num = 0;
static opl_timer_t timer1 = { 12500, 0, 0, 0 };
static opl_timer_t timer2 = { 3125, 0, 0, 0 };
static unsigned int mixing_freq = 0;
static int initialized = 0;

static void AdvanceTime(unsigned int nsamples)
{
    opl_callback_t callback;
    void *callback_data;
    uint64_t us = ((uint64_t) nsamples * OPL_SECOND) / mixing_freq;

    current_time += us;
    if (paused)
    {
        pause_offset += us;
    }

    while (!OPL_Queue_IsEmpty(callback_queue)
        && current_time >= OPL_Queue_Peek(callback_queue) + pause_offset)
    {
        if (!OPL_Queue_Pop(callback_queue, &callback, &callback_data))
        {
            break;
        }
        callback(callback_data);
    }
}

void OPL_Web_AdvanceTime(uint64_t us)
{
    uint64_t target = current_time + us;

    while (initialized && current_time < target)
    {
        uint64_t left = target - current_time;
        unsigned int n = (unsigned int) ((left * mixing_freq + OPL_SECOND - 1) / OPL_SECOND);
        AdvanceTime(n > 0 ? n : 1);
    }
}

// Fill `frames` stereo frames of signed 16-bit audio into buffer.
void OPL_Web_Render(int16_t *buffer, unsigned int frames)
{
    unsigned int filled = 0;

    if (!initialized)
    {
        memset(buffer, 0, frames * 4);
        return;
    }

    while (filled < frames)
    {
        uint64_t nsamples;

        if (paused || OPL_Queue_IsEmpty(callback_queue))
        {
            nsamples = frames - filled;
        }
        else
        {
            uint64_t next = OPL_Queue_Peek(callback_queue) + pause_offset;
            nsamples = next > current_time ? (next - current_time) * mixing_freq : 0;
            nsamples = (nsamples + OPL_SECOND - 1) / OPL_SECOND;
            if (nsamples > frames - filled)
            {
                nsamples = frames - filled;
            }
        }

        if (nsamples > 0)
        {
            OPL3_GenerateStream(&opl_chip, buffer + filled * 2, (uint32_t) nsamples);
        }
        filled += nsamples;
        AdvanceTime(nsamples);
    }
}

static int OPL_Web_Init(unsigned int port_base)
{
    mixing_freq = opl_sample_rate;
    paused = 0;
    pause_offset = 0;
    current_time = 0;
    callback_queue = OPL_Queue_Create();
    OPL3_Reset(&opl_chip, mixing_freq);
    initialized = 1;
    return 1;
}

static void OPL_Web_Shutdown(void)
{
    if (initialized)
    {
        OPL_Queue_Destroy(callback_queue);
        initialized = 0;
    }
}

static unsigned int OPL_Web_PortRead(opl_port_t port)
{
    unsigned int result = 0;

    if (port == OPL_REGISTER_PORT_OPL3)
    {
        return 0xff;
    }
    if (timer1.enabled && current_time > timer1.expire_time)
    {
        result |= 0x80 | 0x40;
    }
    if (timer2.enabled && current_time > timer2.expire_time)
    {
        result |= 0x80 | 0x20;
    }
    return result;
}

static void CalculateEndTime(opl_timer_t *timer)
{
    if (timer->enabled)
    {
        int tics = 0x100 - timer->value;
        timer->expire_time = current_time + ((uint64_t) tics * OPL_SECOND) / timer->rate;
    }
}

static void WriteRegister(unsigned int reg_num, unsigned int value)
{
    switch (reg_num)
    {
        case OPL_REG_TIMER1:
            timer1.value = value;
            CalculateEndTime(&timer1);
            break;
        case OPL_REG_TIMER2:
            timer2.value = value;
            CalculateEndTime(&timer2);
            break;
        case OPL_REG_TIMER_CTRL:
            if (value & 0x80)
            {
                timer1.enabled = 0;
                timer2.enabled = 0;
            }
            else
            {
                if ((value & 0x40) == 0)
                {
                    timer1.enabled = (value & 0x01) != 0;
                    CalculateEndTime(&timer1);
                }
                if ((value & 0x20) == 0)
                {
                    timer2.enabled = (value & 0x02) != 0;
                    CalculateEndTime(&timer2);
                }
            }
            break;
        default:
            OPL3_WriteRegBuffered(&opl_chip, reg_num, value);
            break;
    }
}

static void OPL_Web_PortWrite(opl_port_t port, unsigned int value)
{
    if (port == OPL_REGISTER_PORT)
    {
        register_num = value;
    }
    else if (port == OPL_REGISTER_PORT_OPL3)
    {
        register_num = value | 0x100;
    }
    else if (port == OPL_DATA_PORT)
    {
        WriteRegister(register_num, value);
    }
}

static void OPL_Web_SetCallback(uint64_t us, opl_callback_t callback, void *data)
{
    OPL_Queue_Push(callback_queue, callback, data, current_time - pause_offset + us);
}

static void OPL_Web_ClearCallbacks(void)
{
    OPL_Queue_Clear(callback_queue);
}

static void OPL_Web_Lock(void) {}
static void OPL_Web_Unlock(void) {}

static void OPL_Web_SetPaused(int p)
{
    paused = p;
}

static void OPL_Web_AdjustCallbacks(float factor)
{
    OPL_Queue_AdjustCallbacks(callback_queue, current_time, factor);
}

opl_driver_t opl_web_driver =
{
    "Web",
    OPL_Web_Init,
    OPL_Web_Shutdown,
    OPL_Web_PortRead,
    OPL_Web_PortWrite,
    OPL_Web_SetCallback,
    OPL_Web_ClearCallbacks,
    OPL_Web_Lock,
    OPL_Web_Unlock,
    OPL_Web_SetPaused,
    OPL_Web_AdjustCallbacks,
};
