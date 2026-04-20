// Low-level Windows keyboard hook helper for Local Voice AI.
//
// Listens for a single configured hotkey combination (e.g. Ctrl+Shift+Space)
// and emits JSON lines on stdout when it is pressed or released:
//   {"event":"ready","vk":32,"mods":3}
//   {"event":"keydown","vk":32,"mods":3}
//   {"event":"keyup","vk":32,"mods":3}
//
// Only events matching the configured hotkey are emitted. Every other keystroke
// the user makes is ignored and not written anywhere — this is not a keylogger.

#[cfg(not(windows))]
fn main() {
    eprintln!("hold-to-talk is Windows-only.");
    std::process::exit(1);
}

#[cfg(windows)]
use std::env;
#[cfg(windows)]
use std::io::Write;
#[cfg(windows)]
use std::sync::atomic::{AtomicU32, Ordering};

#[cfg(windows)]
use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
#[cfg(windows)]
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_MENU, VK_SHIFT,
};
#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageA, GetMessageA, SetWindowsHookExA, TranslateMessage,
    UnhookWindowsHookEx, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP,
    WM_SYSKEYDOWN, WM_SYSKEYUP,
};

#[cfg(windows)]
const MOD_CTRL: u32 = 1;
#[cfg(windows)]
const MOD_SHIFT: u32 = 2;
#[cfg(windows)]
const MOD_ALT: u32 = 4;

#[cfg(windows)]
static TARGET_VK: AtomicU32 = AtomicU32::new(0);
#[cfg(windows)]
static REQUIRED_MODS: AtomicU32 = AtomicU32::new(0);

#[cfg(windows)]
unsafe extern "system" fn hook_proc(n_code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
    if n_code >= 0 {
        let kbd = &*(l_param as *const KBDLLHOOKSTRUCT);
        let vk = kbd.vkCode;
        let target = TARGET_VK.load(Ordering::Relaxed);
        if vk == target {
            let msg = w_param as u32;
            let event_kind = match msg {
                WM_KEYDOWN | WM_SYSKEYDOWN => Some("keydown"),
                WM_KEYUP | WM_SYSKEYUP => Some("keyup"),
                _ => None,
            };
            if let Some(kind) = event_kind {
                let mut mods = 0u32;
                if (GetAsyncKeyState(VK_CONTROL as i32) as u16 & 0x8000) != 0 { mods |= MOD_CTRL; }
                if (GetAsyncKeyState(VK_SHIFT as i32) as u16 & 0x8000) != 0 { mods |= MOD_SHIFT; }
                if (GetAsyncKeyState(VK_MENU as i32) as u16 & 0x8000) != 0 { mods |= MOD_ALT; }
                let required = REQUIRED_MODS.load(Ordering::Relaxed);
                if (mods & required) == required {
                    emit(kind, vk, mods);
                }
            }
        }
    }
    CallNextHookEx(std::ptr::null_mut(), n_code, w_param, l_param)
}

#[cfg(windows)]
fn emit(event: &str, vk: u32, mods: u32) {
    let line = format!(
        "{{\"event\":\"{}\",\"vk\":{},\"mods\":{}}}\n",
        event, vk, mods
    );
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    let _ = handle.write_all(line.as_bytes());
    let _ = handle.flush();
}

#[cfg(windows)]
fn parse_hotkey(spec: &str) -> Option<(u32, u32)> {
    let mut mods: u32 = 0;
    let mut key_vk: Option<u32> = None;
    for part_raw in spec.split('+') {
        let part = part_raw.trim().to_lowercase();
        match part.as_str() {
            "ctrl" | "control" => mods |= MOD_CTRL,
            "shift" => mods |= MOD_SHIFT,
            "alt" | "option" => mods |= MOD_ALT,
            "space" => key_vk = Some(0x20),
            "tab" => key_vk = Some(0x09),
            "enter" | "return" => key_vk = Some(0x0D),
            "escape" | "esc" => key_vk = Some(0x1B),
            k if k.len() == 1 => {
                let c = k.chars().next().unwrap();
                if c.is_ascii_alphanumeric() {
                    key_vk = Some(c.to_ascii_uppercase() as u32);
                }
            }
            k if k.starts_with('f') => {
                if let Ok(n) = k[1..].parse::<u32>() {
                    if (1..=24).contains(&n) {
                        key_vk = Some(0x70 + n - 1);
                    }
                }
            }
            _ => return None,
        }
    }
    key_vk.map(|vk| (vk, mods))
}

#[cfg(windows)]
fn main() {
    let args: Vec<String> = env::args().collect();
    let mut hotkey = String::from("ctrl+shift+space");
    let mut i = 1;
    while i < args.len() {
        if args[i] == "--hotkey" && i + 1 < args.len() {
            hotkey = args[i + 1].clone();
            i += 2;
        } else if args[i] == "--version" {
            println!("hold-to-talk {}", env!("CARGO_PKG_VERSION"));
            return;
        } else {
            i += 1;
        }
    }

    let (vk, mods) = match parse_hotkey(&hotkey) {
        Some(v) => v,
        None => {
            eprintln!("Invalid --hotkey: {}", hotkey);
            std::process::exit(2);
        }
    };

    TARGET_VK.store(vk, Ordering::Relaxed);
    REQUIRED_MODS.store(mods, Ordering::Relaxed);

    emit("ready", vk, mods);

    unsafe {
        let hook = SetWindowsHookExA(WH_KEYBOARD_LL, Some(hook_proc), std::ptr::null_mut(), 0);
        if hook.is_null() {
            eprintln!("SetWindowsHookExA failed");
            std::process::exit(1);
        }

        let mut msg: MSG = std::mem::zeroed();
        // GetMessageA returns >0 on message, 0 on WM_QUIT, -1 on error.
        loop {
            let ret = GetMessageA(&mut msg, std::ptr::null_mut(), 0, 0);
            if ret == 0 || ret == -1 { break; }
            TranslateMessage(&msg);
            DispatchMessageA(&msg);
        }

        UnhookWindowsHookEx(hook);
    }
}
