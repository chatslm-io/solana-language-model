use tfhe::boolean::{ciphertext::Ciphertext,server_key::ServerKey,prelude::BinaryBooleanGates};
#[no_mangle]
pub unsafe extern "C" fn retained_encrypted_and(key: *const ServerKey,a:*const Ciphertext,b:*const Ciphertext)->*mut Ciphertext { Box::into_raw(Box::new((*key).and(&*a,&*b))) }
fn no_entropy(_: &mut [u8])->Result<(),getrandom::Error>{Err(getrandom::Error::UNSUPPORTED)}
getrandom::register_custom_getrandom!(no_entropy);
