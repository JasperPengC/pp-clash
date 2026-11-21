//! PP Clash remote backup v1: magic, 16-byte salt, 12-byte nonce, ciphertext and GCM tag.
use ring::{
    aead, pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use std::num::NonZeroU32;
use zeroize::Zeroizing;

const MAGIC: &[u8; 8] = b"PPCLDAV1";
const SALT_LEN: usize = 16;
const SALT_END: usize = MAGIC.len() + SALT_LEN;
const HEADER_LEN: usize = SALT_END + aead::NONCE_LEN;
const MAX_PLAIN: usize = 64 * 1024 * 1024;
pub const MAX_FILE: usize = HEADER_LEN + MAX_PLAIN + 16;

fn key(password: &str, salt: &[u8]) -> Result<aead::LessSafeKey, String> {
    if password.trim().is_empty() {
        return Err("请输入备份口令".into());
    }
    let mut bytes = Zeroizing::new([0u8; 32]);
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(600_000).unwrap(),
        salt,
        password.as_bytes(),
        &mut bytes[..],
    );
    aead::UnboundKey::new(&aead::AES_256_GCM, &bytes[..])
        .map(aead::LessSafeKey::new)
        .map_err(|_| "无法初始化备份密钥".into())
}

pub fn encrypt(data: &[u8], password: &str) -> Result<Vec<u8>, String> {
    if data.len() > MAX_PLAIN {
        return Err("备份超过 64 MiB".into());
    }
    let mut header = [0u8; HEADER_LEN];
    header[..MAGIC.len()].copy_from_slice(MAGIC);
    SystemRandom::new()
        .fill(&mut header[MAGIC.len()..])
        .map_err(|_| "无法生成备份随机数")?;
    let cipher = key(password, &header[MAGIC.len()..SALT_END])?;
    let nonce =
        aead::Nonce::try_assume_unique_for_key(&header[SALT_END..]).map_err(|_| "无效随机数")?;
    let mut file = Vec::with_capacity(HEADER_LEN + data.len() + aead::AES_256_GCM.tag_len());
    file.extend_from_slice(&header);
    file.extend_from_slice(data);
    let tag = cipher
        .seal_in_place_separate_tag(nonce, aead::Aad::from(&header), &mut file[HEADER_LEN..])
        .map_err(|_| "备份加密失败")?;
    file.extend_from_slice(tag.as_ref());
    Ok(file)
}

pub fn decrypt(mut file: Vec<u8>, password: &str) -> Result<Vec<u8>, String> {
    if !(HEADER_LEN + aead::AES_256_GCM.tag_len()..=MAX_FILE).contains(&file.len())
        || !file.starts_with(MAGIC)
    {
        return Err("无效或不支持的加密备份".into());
    }
    let header: [u8; HEADER_LEN] = file[..HEADER_LEN].try_into().unwrap();
    let cipher = key(password, &header[MAGIC.len()..SALT_END])?;
    let nonce =
        aead::Nonce::try_assume_unique_for_key(&header[SALT_END..]).map_err(|_| "无效随机数")?;
    let len = cipher
        .open_within(nonce, aead::Aad::from(&header), &mut file, HEADER_LEN..)
        .map_err(|_| "备份口令错误或文件已损坏")?
        .len();
    file.truncate(len);
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authenticated_round_trip() {
        let state = br#"{"profiles":[]}"#;
        let password = "用于测试的长口令";
        let file = encrypt(state, password).unwrap();
        let second = encrypt(state, password).unwrap();
        assert_ne!(file, second);
        assert!(!file.windows(state.len()).any(|w| w == state));
        assert_eq!(decrypt(file.clone(), password).unwrap(), state);
        assert!(decrypt(file.clone(), "wrong").is_err());
        for pos in [MAGIC.len(), SALT_END, HEADER_LEN, file.len() - 1] {
            let mut changed = file.clone();
            changed[pos] ^= 1;
            assert!(decrypt(changed, password).is_err());
        }
        assert!(decrypt(file[..HEADER_LEN].to_vec(), password).is_err());
        assert!(encrypt(state, " ").is_err());
    }
}
