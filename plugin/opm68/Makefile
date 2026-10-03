#!/usr/bin/make -f
# OPM68 - YM2151 instrument (DPF). Build: make DPF_PATH=../DPF  (add WINDOWS=true with mingw for Windows)

DPF_PATH ?= ../DPF
NAME = OPM68

FILES_DSP = OPM68Plugin.cpp ymfm/ymfm_opm.cpp
FILES_UI  = OPM68UI.cpp NanoButton.cpp

USE_FILE_BROWSER = true
DPF_TARGET_DIR = bin
DPF_BUILD_DIR = build
include $(DPF_PATH)/Makefile.plugins.mk

BUILD_CXX_FLAGS += -std=gnu++17 -Iymfm

TARGETS += vst3 clap

all: $(TARGETS)
