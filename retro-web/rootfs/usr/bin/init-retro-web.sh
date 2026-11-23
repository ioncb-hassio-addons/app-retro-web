#!/command/with-contenv bashio

bashio::log.info "Preparing Retro Web storage"
mkdir -p /data/{roms,bios,saves,profiles,temp}
chmod 0700 /data /data/profiles /data/saves /data/temp
