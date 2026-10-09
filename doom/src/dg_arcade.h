// Hooks between the game code and the web page (arcade leaderboard, wipe).
#ifndef DG_ARCADE_H
#define DG_ARCADE_H

#include "d_player.h"

void DG_LevelDone(wbstartstruct_t *wb, int skill, int episode, int map);
void DG_NewGame(int skill, int episode);
void DG_GameLoaded(void);
void DG_CheatUsed(void);

void DG_WipeBegin(void);
int DG_WipeActive(void);
int DG_WipeTics(void);
void DG_WipeEnd(void);

#endif
