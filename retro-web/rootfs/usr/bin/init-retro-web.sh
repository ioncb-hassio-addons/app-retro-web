#!/command/with-contenv bashio

bashio::log.info "Preparing Retro Web storage"
mkdir -p /data/{roms,bios,covers,saves,profiles,temp,avatars}
mkdir -p /data/avatars/{system,custom}
chmod 0700 /data /data/covers /data/profiles /data/saves /data/temp /data/avatars /data/avatars/system /data/avatars/custom
